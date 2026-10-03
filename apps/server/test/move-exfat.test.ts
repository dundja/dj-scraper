// Publishing onto a real exFAT volume (a disk image), the USB-stick case: no hard links, EXDEV
// from APFS, `._` sidecars. Not part of `pnpm test` (it mounts an image with hdiutil):
//   DJS_TEST_EXFAT=1 pnpm --filter @dj-scraper/server test move-exfat
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/engine/run.ts'
import { createPublish } from '../src/fs/move.ts'
import type { PublishRequest } from '../src/jobs/types.ts'

const enabled = process.env.DJS_TEST_EXFAT === '1'
const HDIUTIL = '/usr/bin/hdiutil'

describe.skipIf(!enabled)('publish onto exFAT', () => {
  let root: string
  let mount: string
  let jobsDir: string

  const hdiutil = async (argv: string[]) => {
    const result = await run(HDIUTIL, argv, { timeoutMs: 60_000 })
    if (result.exitCode !== 0) throw new Error(`hdiutil ${argv[0]} failed: ${result.stderr}`)
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-exfat-')))
    const image = path.join(root, 'usb.dmg')
    mount = path.join(root, 'mnt')
    await mkdir(mount)
    await hdiutil(['create', '-size', '16m', '-fs', 'ExFAT', '-volname', 'DJSTEST', '-o', image])
    await hdiutil(['attach', '-nobrowse', '-mountpoint', mount, image])
    jobsDir = path.join(root, 'data', 'jobs')
    await mkdir(jobsDir, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    await hdiutil(['detach', '-force', mount]).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  async function request(name: string, content: string): Promise<PublishRequest> {
    const attemptId = randomUUID()
    const jobDir = path.join(jobsDir, attemptId)
    await mkdir(jobDir)
    const src = path.join(jobDir, 'final.mp3')
    await writeFile(src, content)
    const dir = await realpath(mount)
    return {
      src,
      folder: { given: mount, real: dir },
      name,
      attemptId,
      jobsDir,
      signal: new AbortController().signal,
    }
  }

  it('copies, claims the name without hard links, and leaves no part or sidecar of ours', async () => {
    const publish = createPublish()
    const result = await publish(await request('Artist - Title.mp3', 'NEW AUDIO'))
    expect(result.status).toBe('moved')
    expect(await readFile(result.path, 'utf8')).toBe('NEW AUDIO')
    const names = await readdir(mount)
    expect(names.filter((name) => name.includes('.djs-'))).toEqual([])
    expect(await readdir(jobsDir)).not.toContainEqual(expect.stringMatching(/\.part\.json$/))
  })

  it('never replaces a file whose name differs only in case or Unicode form', async () => {
    await writeFile(path.join(mount, 'Café - B.mp3'), 'USER')
    const publish = createPublish()
    for (const name of ['café - b.mp3', 'CAFE\u{301} - B.mp3']) {
      const result = await publish(await request(name, 'NEW'))
      expect(result.status).toBe('exists')
    }
    expect(await readFile(path.join(mount, 'Café - B.mp3'), 'utf8')).toBe('USER')
    expect((await readdir(mount)).filter((name) => name.includes('.djs-'))).toEqual([])
  })
})
