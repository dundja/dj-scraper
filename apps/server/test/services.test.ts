import { rm } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killActiveGroups } from '../src/engine/run.ts'
import { SOUNDCLOUD_DOWNLOAD_RESERVE } from '../src/pacing/gates.ts'
import { SOUNDCLOUD_LOOKUP_BUDGET } from '../src/resolve/enricher.ts'
import { monotonicClock } from '../src/resolve/limiter.ts'
import { createServices } from '../src/services.ts'
import { makeTempDir, writeFakeYtdlp } from './helpers.ts'

// The services exactly as the server and `pnpm smoke --download` build them (no overrides), with
// the fake yt-dlp as the engine.

let root = ''
beforeAll(async () => {
  root = await makeTempDir('services')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(killActiveGroups)

describe('createServices', () => {
  it('gives SoundCloud lookups and downloads one budget (D8)', async () => {
    const fake = await writeFakeYtdlp(path.join(root, 'bin'))
    const logs: string[] = []
    const write = (...data: unknown[]) => {
      logs.push(data.map(String).join(' '))
    }
    const { enricher, gates } = createServices({
      engine: { YTDLP_PATH: fake.path },
      dataDirReal: root,
      settings: { get: () => ({ ...DEFAULT_SETTINGS, recentFolders: [], folder: root }) },
      assertContract: true,
      log: { info: write, warn: write, error: write },
    })

    // Downloads start until the bucket is down to the tokens they leave to the lookups: the next
    // download then waits a refill. (Half a refill as the bar: the sums carry rounding error.)
    const { refillMs } = SOUNDCLOUD_LOOKUP_BUDGET
    const now = monotonicClock()
    let downloads = 0
    while (gates.readyAt('soundcloud', now) < now + refillMs / 2) {
      gates.take('soundcloud', now)
      downloads++
    }
    expect(downloads).toBe(SOUNDCLOUD_LOOKUP_BUDGET.burst - SOUNDCLOUD_DOWNLOAD_RESERVE)
    const before = gates.readyAt('soundcloud', monotonicClock())

    // One lookup of a set row (the fake has no rule for it: yt-dlp fails, after its token is spent).
    const url = 'https://soundcloud.com/dj-scraper-test/shared-budget'
    const { results } = await enricher.enrich({
      entries: [{ platform: 'soundcloud', id: '1', url }],
    })
    expect(results).toHaveLength(1)
    expect((await fake.calls()).map((call) => call.url)).toEqual([url])

    // The lookup's token came out of the downloads' bucket: their next start moved one refill on.
    const after = gates.readyAt('soundcloud', monotonicClock())
    expect(after - before).toBeCloseTo(refillMs)
  })
})
