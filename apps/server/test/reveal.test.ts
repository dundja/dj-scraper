import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { killActiveGroups, run } from '../src/engine/run.ts'
import { revealInFinder } from '../src/fs/reveal.ts'
import { StepError } from '../src/jobs/types.ts'
import { type FakeToolBehavior, makeTempDir, writeFakeTool } from './helpers.ts'

// revealInFinder against a fake `open` (never the real one: it would open a Finder window).

let root = ''
let file = ''
beforeAll(async () => {
  root = await makeTempDir('reveal')
  file = path.join(root, 'Artist - Title (Extended Mix).mp3')
  await writeFile(file, 'FAKEAUDIO')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  killActiveGroups()
})

let binCount = 0
const fakeOpen = (behavior: FakeToolBehavior) =>
  writeFakeTool(path.join(root, `bin-${++binCount}`), 'open', behavior)

async function stepFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof StepError)) throw new Error(`expected a StepError, got ${String(error)}`)
  return error.info
}

describe('revealInFinder with a fake open', () => {
  it('runs open -R -- <file>', async () => {
    const bin = await fakeOpen({ argv: ['-R', '--', file] })
    await expect(revealInFinder(file, { bin })).resolves.toBeUndefined()
  })

  it('fails with not_found when open says the file does not exist', async () => {
    const bin = await fakeOpen({ stderr: `The file ${file} does not exist.\n`, exitCode: 1 })
    expect(await stepFailure(revealInFinder(file, { bin }))).toStrictEqual({
      code: 'not_found',
      message: 'The file was moved, deleted, or its drive is unplugged',
    })
  })

  it('fails with unknown when open fails otherwise', async () => {
    const bin = await fakeOpen({ stderr: 'LSOpenURLsWithRole() failed (-10814)\n', exitCode: 1 })
    expect(await stepFailure(revealInFinder(file, { bin }))).toMatchObject({ code: 'unknown' })
  })

  it('fails with not_found for a missing file without running open', async () => {
    const bin = await fakeOpen({})
    const spy = vi.fn<typeof run>(run)
    const missing = path.join(root, 'gone.mp3')
    expect(await stepFailure(revealInFinder(missing, { bin, run: spy }))).toMatchObject({
      code: 'not_found',
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
