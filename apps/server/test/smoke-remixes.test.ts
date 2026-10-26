import { rm } from 'node:fs/promises'
import path from 'node:path'
import { RemixSuggestionsSchema } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  REMIX_SAMPLES,
  type RemixSmokeOptions,
  remixTargets,
  smokeRemixes,
} from '../scripts/smoke-remixes.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { type FakeYtdlp, makeTempDir, writeFakeYtdlp } from './helpers.ts'

// `pnpm smoke --remixes` (scripts/smoke-remixes.ts) offline: the same code that runs live, driving
// the fake yt-dlp and the recorded searches, so the script can't rot between live runs.

const PORCELAIN = { label: 'Porcelain', title: 'Porcelain', artist: 'Moby' }
/** The mix's seed video: Rick Astley, whose song's searches are recorded too. */
const MIX = {
  label: 'Mix track',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
}
const PLAYLIST = {
  label: 'Playlist',
  url: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
}

let root = ''
let count = 0
beforeAll(async () => {
  root = await makeTempDir('smoke-remixes')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(killActiveGroups)

type Run = { failures: number; output: string; printed: string[]; logs: string[]; fake: FakeYtdlp }

async function smoke(
  targets: RemixSmokeOptions['targets'],
  options: Partial<Pick<RemixSmokeOptions, 'json' | 'mode'>> = {},
): Promise<Run> {
  const fake = await writeFakeYtdlp(path.join(root, `run-${++count}`))
  const lines: string[] = []
  const printed: string[] = []
  const logs: string[] = []
  const write = (...data: unknown[]) => logs.push(data.map(String).join(' '))
  const failures = await smokeRemixes({
    targets,
    json: options.json ?? false,
    mode: options.mode ?? 'auto',
    engine: { YTDLP_PATH: fake.path },
    say: (line) => lines.push(line),
    print: (text) => printed.push(text),
    log: { info: write, warn: write, error: write },
  })
  return { failures, output: lines.join('\n'), printed, logs, fake }
}

/** The lines the smoke printed for one target, from its ✅/❌ line to the blank line. */
function block(output: string, label: string): string {
  const found = output.split('\n\n').find((text) => text.includes(` ${label}: `))
  if (found === undefined) throw new Error(`no block for ${label} in:\n${output}`)
  return found
}

describe('remixTargets', () => {
  it('reads a title and the text after it as a song, and a link as a track to resolve', () => {
    expect(
      remixTargets(['Porcelain', 'Moby', 'https://youtu.be/dQw4w9WgXcQ', 'Innerbloom']),
    ).toEqual([
      { label: '', title: 'Porcelain', artist: 'Moby' },
      { label: '', url: 'https://youtu.be/dQw4w9WgXcQ' },
      { label: '', title: 'Innerbloom' },
    ])
  })

  it('gives a title before a link no artist', () => {
    expect(remixTargets(['Porcelain', 'http://soundcloud.com/x/y'])).toEqual([
      { label: '', title: 'Porcelain' },
      { label: '', url: 'http://soundcloud.com/x/y' },
    ])
  })

  it('has the sample songs of the smoke-test skill', () => {
    expect(REMIX_SAMPLES).toEqual([
      { label: 'Moby – Porcelain', title: 'Porcelain', artist: 'Moby' },
      { label: 'RÜFÜS DU SOL – Innerbloom', title: 'Innerbloom', artist: 'RÜFÜS DU SOL' },
    ])
  })
})

describe('pnpm smoke --remixes', () => {
  it('asks for YouTube first, then both, and prints each suggestion with its plays, kind, remixer, genre and platforms', async () => {
    const run = await smoke([PORCELAIN])
    expect(run.failures).toBe(0)
    const porcelain = block(run.output, 'Porcelain')
    expect(porcelain).toMatch(/^✅ Porcelain: “Porcelain” by Moby \(\d+\.\d s\)/)
    expect(porcelain).toContain('song “Porcelain” by Moby · query “Moby Porcelain remix”')
    expect(porcelain).toContain('youtube 22 found · soundcloud 27 found · 20 suggestions')
    expect(porcelain).toMatch(
      /timings: YouTube \d+\.\d s, then SoundCloud \d+\.\d s \(YouTube's search cached\)/,
    )
    expect(porcelain).toContain(
      '1. 908,188 plays · remix · Arty · no genre · youtube ×2, soundcloud ×2 · “Porcelain (Arty Remix)” https://www.youtube.com/watch?v=MU5FD_0iWHk',
    )
    expect(porcelain).toMatch(
      / plays · remix · Pola & Bryson · Drum & Bass \(SoundCloud genre\) · youtube ×2, soundcloud ×1 · /,
    )
    expect(porcelain).toMatch(/ plays · remix · Chiro · Melodic House \(named in text\) · /)
    expect(run.output.endsWith('1/1 searched')).toBe(true)

    // YouTube's search ran once: the second request took it from the cache.
    expect((await run.fake.calls()).map((call) => call.url)).toEqual([
      'ytsearch30:Moby Porcelain remix',
      'scsearch30:Moby Porcelain remix',
    ])
    // The finder's log names no song.
    expect(run.logs.join('\n')).not.toContain('Porcelain')
  })

  it('resolves a track link first and searches its song, leaving the track out', async () => {
    const run = await smoke([MIX], { mode: 'track' })
    expect(run.failures).toBe(0)
    const mix = block(run.output, 'Mix track')
    expect(mix).toContain(
      'song “Never Gonna Give You Up” by Rick Astley · query “Rick Astley Never Gonna Give You Up remix”',
    )
    expect(mix).toMatch(/1\. 578,820 plays · remix · Krysiek · /)
    // The heading names the link; no suggestion is the pasted video.
    expect(mix.split('\n').slice(1).join('\n')).not.toContain('watch?v=dQw4w9WgXcQ')

    const json = await smoke([MIX], { mode: 'track', json: true })
    expect(JSON.parse(json.printed[0] ?? '').request).toEqual({
      title: 'Never Gonna Give You Up (Official Video) (4K Remaster)',
      artist: 'Rick Astley',
      uploader: 'Rick Astley',
      exclude: { platform: 'youtube', id: 'dQw4w9WgXcQ' },
    })
  })

  it('prints one JSON document per song with --json, and no human lines', async () => {
    const run = await smoke([PORCELAIN], { json: true })
    expect(run.failures).toBe(0)
    expect(run.printed).toHaveLength(1)
    const document = JSON.parse(run.printed[0] ?? '')
    expect(document).toMatchObject({
      target: PORCELAIN,
      ok: true,
      request: { title: 'Porcelain', artist: 'Moby' },
      query: 'Moby Porcelain remix',
      timings: { youtubeMs: expect.any(Number), totalMs: expect.any(Number) },
    })
    expect(RemixSuggestionsSchema.parse(document.answer).suggestions[0]?.remixer).toBe('Arty')
    expect(run.output).not.toContain('✅')
    expect(run.output.endsWith('1/1 searched')).toBe(true)
  })

  it('counts a song whose searches failed, and a link that is a list, as failed', async () => {
    // The fake has no recording of this song's searches, and the playlist is no track.
    const run = await smoke([{ label: 'Unrecorded', title: 'Nothing', artist: 'Nobody' }, PLAYLIST])
    expect(run.failures).toBe(2)
    const unrecorded = block(run.output, 'Unrecorded')
    expect(unrecorded).toMatch(/^❌ Unrecorded: /)
    expect(unrecorded).toContain('youtube ❌ unknown: ')
    expect(unrecorded).toContain('soundcloud ❌ unknown: ')
    expect(block(run.output, 'Playlist')).toContain(
      'invalid_request: --remixes takes track links, not lists',
    )
    expect(run.output.endsWith('0/2 searched, see ❌ above')).toBe(true)
  })

  it('reports a title with no words as invalid_request, running nothing', async () => {
    const run = await smoke([{ label: 'Empty', title: '(Official Video)' }], { json: true })
    expect(run.failures).toBe(1)
    expect(JSON.parse(run.printed[0] ?? '')).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
    expect(await run.fake.calls()).toEqual([])
  })
})
