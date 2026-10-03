import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DataDirLock, lockDataDir, prepareDataDir, sweepLeftovers } from '../src/data-dir.ts'
import { killActiveGroups, run } from '../src/engine/run.ts'
import { makeTempDir } from './helpers.ts'

const MODULE = pathToFileURL(path.resolve(import.meta.dirname, '../src/data-dir.ts')).href
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

/**
 * A second server process (node running the real data-dir module) that takes the lock on `dir`
 * and prints `LOCKED <pid>`, or `REFUSED <holder pid>` when it can't, then stays (or exits).
 */
function otherServer(dir: string, signal: AbortSignal) {
  const script = `
    const { lockDataDir } = await import(process.argv[1])
    try {
      const lock = await lockDataDir(process.argv[2], { waitMs: 0, log: { info() {}, warn() {}, error() {} } })
      lock.setPort(4999)
      console.log('LOCKED ' + process.pid)
      setInterval(() => {}, 1000)
    } catch (error) {
      console.log('REFUSED ' + error.holder?.pid)
    }`
  const { promise: line, resolve } = Promise.withResolvers<string>()
  const done = run(process.execPath, ['--input-type=module', '-e', script, MODULE, dir], {
    signal,
    killGraceMs: 500,
    timeoutMs: 20_000,
    onStdoutLine: resolve,
  })
  return { line, done }
}

let root = ''
const locks: DataDirLock[] = []
beforeEach(async () => {
  root = await realpath(await makeTempDir('data-dir'))
})
afterEach(async () => {
  killActiveGroups()
  for (const lock of locks.splice(0)) lock.release()
  await rm(root, { recursive: true, force: true })
})

describe('lockDataDir across processes', () => {
  it('refuses a data dir another server process holds, naming it, and gets it once that one dies', async () => {
    const controller = new AbortController()
    const other = otherServer(root, controller.signal)
    const [, pid] = (await other.line).split(' ')
    const error = await lockDataDir(root, { waitMs: 0, log: log() }).catch((e: unknown) => e)
    expect(error).toMatchObject({
      name: 'DataDirLocked',
      holder: { pid: Number(pid), port: 4999 },
    })
    // Killed outright (a crash): the kernel drops its lock with its last fd.
    process.kill(Number(pid), 'SIGKILL')
    await other.done
    const lock = await lockDataDir(root, { waitMs: 0, log: log() })
    locks.push(lock)
    expect(lock.exclusive).toBe(true)
  })

  it('keeps another server process out while this one holds the data dir', async () => {
    const lock = await lockDataDir(root, { waitMs: 0, log: log() })
    locks.push(lock)
    const other = otherServer(root, new AbortController().signal)
    expect(await other.line).toBe(`REFUSED ${process.pid}`)
    await other.done
  })

  it('is not inherited by the processes it spawns', async () => {
    const lock = await lockDataDir(root, { waitMs: 0, log: log() })
    const controller = new AbortController()
    const child = run('/bin/sleep', ['30'], { signal: controller.signal })
    lock.release()
    const next = await lockDataDir(root, { waitMs: 0, log: log() })
    locks.push(next)
    expect(next.exclusive).toBe(true)
    controller.abort()
    await child
  })
})

describe('sweepLeftovers with real processes', () => {
  it('kills a detached leftover group whose argv names a job dir, and removes the dir', async () => {
    const dataDir = await prepareDataDir(path.join(root, 'data'))
    const jobDir = path.join(dataDir, 'jobs', randomUUID())
    await mkdir(jobDir)
    await writeFile(path.join(jobDir, 'x.webm'), 'partial')
    // Like a yt-dlp left by a crashed server: its own group, the job dir in its argv ($0 here),
    // and a child (sleep, like ffmpeg) in the same group whose argv doesn't name it.
    const started = (argv0: string) => {
      const { promise: child, resolve } = Promise.withResolvers<number>()
      const done = run('/bin/sh', ['-c', 'sleep 30 & echo $!; wait', argv0], {
        timeoutMs: 20_000,
        onStdoutLine: (line) => resolve(Number(line)),
      })
      return { child, done }
    }
    const leftover = started(jobDir)
    // A process of another data dir that only ends like ours is left alone.
    const bystander = started(`/Volumes/X${jobDir}`)
    const [sleepPid] = await Promise.all([leftover.child, bystander.child])
    const result = await sweepLeftovers(dataDir, { log: log() })
    expect(result).toEqual({ killed: 1, removed: 1, parts: 0 })
    expect(await readdir(path.join(dataDir, 'jobs'))).toEqual([])
    // The shell dies of the SIGKILL, or exits 0 when its child's death woke it first: a group
    // signal skips a process that is already exiting. Either way long before its 20 s timeout.
    expect(await leftover.done).toMatchObject({ timedOut: false })
    await expect.poll(() => isAlive(sleepPid), { timeout: 2000 }).toBe(false)
    expect(await isAlive((await bystander.child) ?? 0)).toBe(true)
    killActiveGroups()
    expect(await bystander.done).toMatchObject({ timedOut: false })
  })
})

/** Running, and not a zombie (a killed orphan stays one until launchd reaps it). */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const ps = await run('/bin/ps', ['-o', 'stat=', '-p', String(pid)])
  return ps.stdout.trim() !== '' && !ps.stdout.trim().startsWith('Z')
}
