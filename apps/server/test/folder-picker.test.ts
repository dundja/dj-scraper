import { mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killActiveGroups, run } from '../src/engine/run.ts'
import { createFolderPicker, pickerArgv } from '../src/fs/folder-picker.ts'
import { ApiError } from '../src/http/errors.ts'
import { type FakeToolBehavior, makeTempDir, writeFakeTool } from './helpers.ts'

// The picker against a fake osascript (never the real one: it would open a dialog). Checks that the
// script and start folder reach the binary as argv and that stopping it ends the pick.

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

let root = ''
let start = ''
beforeAll(async () => {
  root = await makeTempDir('folder-picker')
  start = path.join(root, 'Music')
  await mkdir(start)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  killActiveGroups()
})

let binCount = 0
/** A picker whose osascript behaves as told; `spawned` resolves once it has been started. */
async function fakePicker(behavior: FakeToolBehavior, timeoutMs?: number) {
  const bin = await writeFakeTool(path.join(root, `bin-${++binCount}`), 'osascript', behavior)
  let started: () => void = () => {}
  const spawned = new Promise<void>((resolve) => {
    started = resolve
  })
  const spy: typeof run = (file, argv, options) => {
    const running = run(file, argv, options)
    started()
    return running
  }
  return { picker: createFolderPicker({ bin, run: spy, timeoutMs, log: quiet }), spawned }
}

describe('createFolderPicker with a fake osascript', () => {
  it('passes the script and the start folder as argv and returns the real path picked', async () => {
    const { picker } = await fakePicker({ argv: pickerArgv(start), stdout: `${start}/\n` })
    expect(await picker.pick(start)).toStrictEqual({ path: await realpath(start) })
  })

  it('leaves out a start folder that does not exist', async () => {
    const { picker } = await fakePicker({ argv: pickerArgv(undefined), stdout: '\n' })
    expect(await picker.pick(path.join(root, 'missing'))).toStrictEqual({ canceled: true })
  })

  it('reports a user cancel as canceled', async () => {
    const { picker } = await fakePicker({
      stderr: '0:17: execution error: User canceled. (-128)\n',
      exitCode: 1,
    })
    expect(await picker.pick(undefined)).toStrictEqual({ canceled: true })
  })

  it('stops osascript when the time runs out', async () => {
    const { picker } = await fakePicker({ hang: true }, 50)
    expect(await picker.pick(undefined)).toStrictEqual({ canceled: true })
  })

  it('stops osascript when the request is dropped', async () => {
    const { picker, spawned } = await fakePicker({ hang: true })
    const controller = new AbortController()
    const picking = picker.pick(undefined, controller.signal)
    await spawned
    controller.abort()
    expect(await picking).toStrictEqual({ canceled: true })
  })

  it('needs the desktop session when osascript has none (-1713)', async () => {
    const { picker } = await fakePicker({
      stderr: '191:282: execution error: No user interaction allowed. (-1713)\n',
      exitCode: 1,
    })
    const error = await picker.pick(undefined).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'unknown',
      message: 'The folder picker needs the Mac desktop session',
    })
  })

  it('fails with unknown when osascript is missing', async () => {
    const picker = createFolderPicker({ bin: path.join(root, 'no-such-osascript'), log: quiet })
    const error = await picker.pick(undefined).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'unknown', message: 'The folder picker failed' })
  })
})
