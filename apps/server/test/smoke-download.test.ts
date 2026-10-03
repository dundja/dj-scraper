import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadFormat } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type DownloadSmokeOptions, smokeDownloads } from '../scripts/smoke-download.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { type FakeEngine, makeTempDir, writeFakeEngine } from './helpers.ts'

// `pnpm smoke --download` (scripts/smoke-download.ts) offline: the same code that runs live,
// driving the fake engine, so the script can't rot between live runs.

const YOUTUBE = { label: 'YouTube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }
const SECRET = {
  label: 'Secret',
  url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
}
const PREVIEW = { label: 'Go+', url: 'https://soundcloud.com/the-concept-band/world-on-fire-1' }
const PLAYLIST = {
  label: 'Playlist',
  url: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
}

let root = ''
let count = 0
beforeAll(async () => {
  root = await makeTempDir('smoke-download')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(killActiveGroups)

type Run = {
  failures: number
  /** What the smoke printed, one string. */
  output: string
  /** What the services logged. */
  logs: string[]
  /** The temp parent's entries afterwards: the smoke's temp dir, if kept. */
  left: string[]
  tempParent: string
  /** `exit` listeners the run left behind. */
  exitListeners: number
  engine: FakeEngine
}

async function smoke(
  targets: DownloadSmokeOptions['targets'],
  formats: DownloadFormat[],
  options: Partial<Pick<DownloadSmokeOptions, 'keep' | 'bare'>> = {},
): Promise<Run> {
  const base = path.join(root, `run-${++count}`)
  const engine = await writeFakeEngine(path.join(base, 'bin'))
  const tempParent = path.join(base, 'tmp')
  await mkdir(tempParent, { recursive: true })
  const lines: string[] = []
  const logs: string[] = []
  const write = (...data: unknown[]) => logs.push(data.map(String).join(' '))
  const listenersBefore = process.listenerCount('exit')
  const failures = await smokeDownloads({
    targets,
    formats,
    keep: options.keep ?? false,
    bare: options.bare ?? false,
    mode: 'auto',
    engine: { YTDLP_PATH: engine.ytdlp.path, FFMPEG_PATH: engine.ffmpeg.ffmpeg },
    say: (line) => lines.push(line),
    log: { info: write, warn: write, error: write },
    tempParent,
  })
  return {
    failures,
    output: lines.join('\n'),
    logs,
    left: await readdir(tempParent),
    tempParent,
    exitListeners: process.listenerCount('exit') - listenersBefore,
    engine,
  }
}

/** The lines the smoke printed for one URL × format, from its ✅/❌ line to the blank line. */
function block(output: string, label: string, format: DownloadFormat): string {
  const blocks = output.split('\n\n')
  const found = blocks.find((text) => text.includes(`${label}: `) && text.includes(`→ ${format}:`))
  if (found === undefined) throw new Error(`no block for ${label} → ${format} in:\n${output}`)
  return found
}

describe('pnpm smoke --download', () => {
  it('downloads every URL × format through the pipeline, reads each file back and deletes them', async () => {
    const run = await smoke([YOUTUBE, SECRET], ['mp3', 'aiff'])
    expect(run.failures).toBe(0)

    const youtubeMp3 = block(run.output, 'YouTube', 'mp3')
    expect(youtubeMp3).toContain(
      '✅ YouTube: https://www.youtube.com/watch?v=jNQXAC9IVRw → mp3: done',
    )
    expect(youtubeMp3).toMatch(/statuses {2}queued → downloading → processing → done/)
    expect(youtubeMp3).toMatch(/source {4}opus \d+ kbps/)
    expect(youtubeMp3).toMatch(/output {4}mp3 · 320 kbps · .* · encoded/)
    expect(youtubeMp3).toContain('file      jawed - Me at the zoo.mp3')
    expect(youtubeMp3).toMatch(/ffprobe {3}mp3 · /)
    expect(youtubeMp3).toContain(
      'COMM(eng,“”) “https://www.youtube.com/watch?v=jNQXAC9IVRw” · APIC image/jpeg type 3',
    )
    // The fake engine's covers are not real JPEGs: a warning, not a failure.
    expect(youtubeMp3).toContain('cover     ⚠️  no JPEG frame header found')

    const youtubeAiff = block(run.output, 'YouTube', 'aiff')
    expect(youtubeAiff).toMatch(/output {4}pcm_s16be · .* · encoded/)
    expect(youtubeAiff).toContain('file      jawed - Me at the zoo.aiff')
    expect(youtubeAiff).toMatch(/ID3v2\.3 {3}TIT2 “Me at the zoo” · TPE1 “jawed” · COMM/)

    // A secret link: the MP3 stream is copied, and no comment names the link (D2).
    const secretMp3 = block(run.output, 'Secret', 'mp3')
    expect(secretMp3).toMatch(/source {4}mp3 128 kbps/)
    expect(secretMp3).toMatch(/output {4}mp3 · 128 kbps · .* · copied/)
    expect(secretMp3).toMatch(/ID3v2\.3 {3}TIT2 /)
    expect(secretMp3).not.toContain('COMM')
    expect(run.logs.filter((line) => line.includes('2 new (0 refused)'))).toHaveLength(2)

    // Nothing left: the temp dir (data dir, folder, files) and the exit hook are gone.
    expect(run.left).toEqual([])
    expect(run.exitListeners).toBe(0)
    // D18: the services' logs name no URLs, titles or paths.
    const logs = run.logs.join('\n')
    for (const secret of ['youtube.com', 'soundcloud.com', 'Me at the zoo', run.tempParent]) {
      expect(logs).not.toContain(secret)
    }
  })

  it('keeps the temp dir and its files with --keep', async () => {
    const run = await smoke([YOUTUBE], ['m4a'], { keep: true })
    expect(run.failures).toBe(0)
    expect(block(run.output, 'YouTube', 'm4a')).toMatch(/output {4}aac · .* · copied/)
    expect(run.left).toHaveLength(1)
    const folder = path.join(run.tempParent, run.left[0] ?? '', 'folder')
    expect(run.output).toContain(`kept: ${folder}`)
    expect(await readdir(folder)).toEqual(['jawed - Me at the zoo.m4a'])
    expect(await readdir(path.join(run.tempParent, run.left[0] ?? '', 'data', 'jobs'))).toEqual([])
    expect(run.exitListeners).toBe(0)
  })

  it('fails a Go+ track as preview_only: at enqueue when resolved, by the break filter when bare', async () => {
    const resolved = await smoke([PREVIEW], ['mp3'])
    expect(resolved.failures).toBe(1)
    const refused = block(resolved.output, 'Go+', 'mp3')
    expect(refused).toContain('→ mp3: failed (never started)')
    expect(refused).toMatch(/statuses {2}failed · no progress events/)
    expect(refused).toContain('error     preview_only: ')
    // Only the resolve ran: no download was spawned.
    expect((await resolved.engine.ytdlp.calls()).map((call) => call.argv.includes('-J'))).toEqual([
      true,
    ])

    const bare = await smoke([PREVIEW], ['mp3'], { bare: true })
    expect(bare.failures).toBe(1)
    const broken = block(bare.output, 'Go+', 'mp3')
    expect(broken).toMatch(/statuses {2}queued → downloading → failed/)
    expect(broken).toContain('error     preview_only: ')
    expect(await bare.engine.ytdlp.calls()).toHaveLength(2)
    expect(bare.left).toEqual([])
  })

  it('counts a link that resolves to a list as failed for every format, downloading nothing', async () => {
    const run = await smoke([PLAYLIST], ['mp3', 'flac'])
    expect(run.failures).toBe(2)
    expect(run.output).toContain('--download takes track links')
    expect(await run.engine.ytdlp.calls()).toHaveLength(1)
    expect(run.left).toEqual([])
  })
})
