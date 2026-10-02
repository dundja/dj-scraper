import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { classifyUrl } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killActiveGroups, run } from '../src/engine/run.ts'
import { resolveArgs } from '../src/engine/ytdlp-args.ts'
import {
  FAKE_YTDLP,
  type FakeYtdlpKnobs,
  type FakeYtdlpRule,
  makeTempDir,
  todaysYtdlpVersion,
  writeFakeYtdlp,
} from './helpers.ts'

// The fake yt-dlp is what every integration and e2e test resolves against, so it has to answer
// like yt-dlp for our argv, and its manifest has to cover the recorded fixtures exactly.

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

/** The base argv the fixtures were recorded with (and that baseArgs builds). */
const BASE = [
  '--ignore-config',
  '--no-update',
  '--color',
  'never',
  '--encoding',
  'utf-8',
  '--js-runtimes',
  `node:${process.execPath}`,
]
const DUMP = [...BASE, '-J', '--flat-playlist']

const URLS = {
  video: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  watchList: 'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  mix: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  window: 'https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2',
  channelRoot: 'https://www.youtube.com/@NoCopyrightSounds',
  private: 'https://www.youtube.com/watch?v=bM7SZ5SBzyY',
  secretTrack: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
  set: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
  entry: 'https://api-v2.soundcloud.com/tracks/47127631',
}

/** The fields of a -J document these tests look at. */
type Info = {
  _type?: string
  id?: string
  title?: string
  original_url?: string
  playlist_count?: number | null
  requested_entries?: number[]
  entries?: Info[]
  formats?: unknown[]
}

const parseInfo = (text: string): Info => JSON.parse(text) as Info
const fixtureText = (file: string): string => readFileSync(path.join(FIXTURES, file), 'utf8')
const fixtureInfo = (file: string): Info => parseInfo(fixtureText(file))
const ids = (info: Info): (string | undefined)[] => (info.entries ?? []).map((entry) => entry.id)

const MANIFEST_RULES = (JSON.parse(fixtureText('fake-yt-dlp.json')) as { rules: FakeYtdlpRule[] })
  .rules

let root = ''
let cases = 0
beforeAll(async () => {
  root = await makeTempDir('fake-ytdlp')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
// A hanging fake outlives a failed test (Vitest can't reach its process group), so reap it.
afterEach(() => {
  killActiveGroups()
})

/** A fresh fake per test, so call logs and extra manifests never leak between tests. */
const fake = (options?: { manifestRules?: FakeYtdlpRule[]; env?: FakeYtdlpKnobs }) =>
  writeFakeYtdlp(path.join(root, `case-${++cases}`), options)

describe('fake yt-dlp: the binary and --version', () => {
  it('keeps its exec bit, which every symlink to it relies on', () => {
    expect(statSync(FAKE_YTDLP).mode & 0o111).toBe(0o111)
  })

  it("prints today's date as a stable version, so the engine never looks stale", async () => {
    const ytdlp = await fake()
    const before = todaysYtdlpVersion()
    const result = await run(ytdlp.path, ['--ignore-config', '--no-update', '--version'])
    const after = todaysYtdlpVersion()
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect([`${before}\n`, `${after}\n`]).toContain(result.stdout)
  })

  it('prints FAKE_YTDLP_VERSION instead when it is set', async () => {
    const ytdlp = await fake({ env: { FAKE_YTDLP_VERSION: '2026.09.27.232945' } })
    const result = await run(ytdlp.path, ['--ignore-config', '--no-update', '--version'])
    expect(result).toMatchObject({ exitCode: 0, stdout: '2026.09.27.232945\n' })
  })

  it('answers --version at once even when every other call hangs', async () => {
    const ytdlp = await fake({ env: { FAKE_YTDLP_HANG: '1', FAKE_YTDLP_DELAY_MS: '60000' } })
    const result = await run(ytdlp.path, ['--version'], { timeoutMs: 2_000 })
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
  })
})

describe('fake yt-dlp: replaying fixtures', () => {
  it('prints a recorded track as one line of JSON, as -J does', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '--no-playlist', '--', URLS.video])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout.endsWith('\n')).toBe(true)
    expect(result.stdout.trimEnd()).not.toContain('\n')
    expect(JSON.parse(result.stdout)).toEqual(fixtureInfo('youtube/video.json'))
  })

  it("escapes non-ASCII characters like yt-dlp's json.dumps", async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '--no-playlist', '--', URLS.secretTrack])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^[\x20-\x7e]+\n$/)
    expect(result.stdout).toContain('\\u')
    expect(JSON.parse(result.stdout)).toEqual(fixtureInfo('soundcloud/track-secret.json'))
  })

  it.each([
    ['--no-playlist', 'the track', 'video'],
    ['--yes-playlist', 'the list', 'playlist'],
    [undefined, "the list (yt-dlp's default)", 'playlist'],
  ])('serves watch?v=…&list=… with %s as %s', async (flag, _what, type) => {
    const ytdlp = await fake()
    const argv = [...DUMP, ...(flag === undefined ? [] : [flag]), '--', URLS.watchList]
    const result = await run(ytdlp.path, argv)
    expect(result.exitCode).toBe(0)
    expect(parseInfo(result.stdout)._type).toBe(type)
  })

  it('answers the argv resolveArgs builds for a mix with one row over the cap', async () => {
    const ytdlp = await fake()
    const argv = resolveArgs({
      url: URLS.mix,
      playlist: 'yes',
      limit: 50,
      jsRuntime: process.execPath,
    })
    const result = await run(ytdlp.path, argv)
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(parseInfo(result.stdout).entries).toHaveLength(51)
  })

  it('tells a metadata-only entry lookup from a full one by its args', async () => {
    const ytdlp = await fake()
    const full = await run(ytdlp.path, [...BASE, '-J', '--no-playlist', '--', URLS.entry])
    expect(full).toMatchObject({ exitCode: 0, stderr: '' })
    expect(parseInfo(full.stdout).formats).not.toHaveLength(0)

    const metadataOnly = await run(ytdlp.path, [
      ...BASE,
      '-J',
      '--no-playlist',
      '--extractor-args',
      'soundcloud:formats=none',
      '--ignore-no-formats-error',
      '--',
      URLS.entry,
    ])
    expect(metadataOnly).toMatchObject({
      exitCode: 0,
      stderr: fixtureText('errors/soundcloud-metadata-only.log'),
    })
    expect(parseInfo(metadataOnly.stdout).formats).toEqual([])
  })

  it('serves the recorded capped set for -I 1:3, and the whole set otherwise', async () => {
    const ytdlp = await fake()
    const capped = await run(ytdlp.path, [...DUMP, '-I', '1:3', '--', URLS.set])
    expect(JSON.parse(capped.stdout)).toEqual(fixtureInfo('soundcloud/set-capped.json'))
    const whole = await run(ytdlp.path, [...DUMP, '--', URLS.set])
    expect(JSON.parse(whole.stdout)).toEqual(fixtureInfo('soundcloud/set.json'))
  })
})

describe('fake yt-dlp: -I', () => {
  it('keeps the entries in an A:B range, with the recorded playlist_count', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '-I', '2:4', '--', URLS.set])
    const info = parseInfo(result.stdout)
    expect(ids(info)).toEqual(ids(fixtureInfo('soundcloud/set.json')).slice(1, 4))
    expect(info).toMatchObject({ playlist_count: 6, requested_entries: [2, 3, 4] })
  })

  it('keeps a single entry for -I N', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '--yes-playlist', '-I', '5', '--', URLS.mix])
    const info = parseInfo(result.stdout)
    expect(ids(info)).toEqual([ids(fixtureInfo('youtube/mix.json'))[4]])
    expect(info).toMatchObject({ playlist_count: null, requested_entries: [5] })
  })

  it('leaves the document as recorded when the range covers every row', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '-I', '1:5001', '--', URLS.set])
    expect(JSON.parse(result.stdout)).toEqual(fixtureInfo('soundcloud/set.json'))
  })

  it('selects rows of a recorded window by their real playlist indices', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '-I', '1:60', '--', URLS.window])
    const info = parseInfo(result.stdout)
    expect(info.requested_entries).toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
    expect(ids(info)).toEqual(
      ids(fixtureInfo('youtube/playlist-unavailable-entries.json')).slice(0, 12),
    )
    expect(info.playlist_count).toBe(162)
  })

  it('cuts nested tab playlists too, since -I applies at every level', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '-I', '1:2', '--', URLS.channelRoot])
    const tabs = parseInfo(result.stdout).entries ?? []
    expect(tabs.map((tab) => tab.title)).toEqual([
      'NoCopyrightSounds - Videos',
      'NoCopyrightSounds - Shorts',
    ])
    for (const tab of tabs) {
      expect(tab.entries).toHaveLength(2)
      expect(tab.requested_entries).toEqual([1, 2])
    }
  })

  it.each(['-3', '1:10:2', '0', '5:2', 'all'])('refuses -I %s with exit 2', async (spec) => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '-I', spec, '--', URLS.set])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/^fake-yt-dlp: unsupported -I/)
  })
})

describe('fake yt-dlp: failures', () => {
  it('replays an error log on stderr with its exit code', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...DUMP, '--no-playlist', '--', URLS.private])
    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: fixtureText('errors/youtube-private.log'),
    })
  })

  it('answers a URL without a rule as Unsupported URL, exit 1', async () => {
    const ytdlp = await fake()
    const url = 'https://www.youtube.com/watch?v=NoFixture01'
    const result = await run(ytdlp.path, [...DUMP, '--', url])
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: `ERROR: Unsupported URL: ${url}\n`,
    })
  })

  it.each([
    ['--ignore-config is missing', ['--no-update', '-J', '--', URLS.video]],
    ['--no-update is missing', ['--ignore-config', '-J', '--', URLS.video]],
    ['there is no --', [...BASE, '-J', URLS.video]],
    ['two arguments follow --', [...BASE, '-J', '--', URLS.video, URLS.mix]],
    ['nothing follows --', [...BASE, '-J', '--']],
  ])('exits 2 like a strict yt-dlp when %s', async (_why, argv) => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, argv)
    expect(result).toMatchObject({ exitCode: 2, stdout: '' })
    expect(result.stderr).toMatch(/^fake-yt-dlp: .+\n$/)
  })

  it('refuses to serve an info document to a call without -J (downloads are not faked)', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...BASE, '--', URLS.video])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('youtube/video.json is a -J document')
  })

  it('refuses a flat listing to a call without --flat-playlist', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, [...BASE, '-J', '--', URLS.set])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('recorded with --flat-playlist')
  })
})

describe('fake yt-dlp: knobs', () => {
  it('waits FAKE_YTDLP_DELAY_MS before answering', async () => {
    const ytdlp = await fake({ env: { FAKE_YTDLP_DELAY_MS: '300' } })
    const result = await run(ytdlp.path, [...DUMP, '--', URLS.video])
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(300)
    expect(parseInfo(result.stdout).id).toBe('jNQXAC9IVRw')
  })

  it('hangs with FAKE_YTDLP_HANG=1 until SIGINT, then exits 1 as yt-dlp does', async () => {
    const ytdlp = await fake({ env: { FAKE_YTDLP_HANG: '1' } })
    const controller = new AbortController()
    const running = run(ytdlp.path, [...DUMP, '--', URLS.video], { signal: controller.signal })
    // The fake logs its call after installing its SIGINT handler, so it is ready now.
    await ytdlp.waitForCalls(1)
    controller.abort()
    const result = await running
    expect(result).toMatchObject({
      aborted: true,
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: fixtureText('errors/interrupted.log'),
    })
  })

  it('logs every call with its argv, URL and pid', async () => {
    const ytdlp = await fake()
    const version = await run(ytdlp.path, ['--version'])
    const argv = [...DUMP, '--no-playlist', '--', URLS.video]
    const lookup = await run(ytdlp.path, argv)
    const calls = await ytdlp.calls()
    expect(calls).toMatchObject([
      { argv: ['--version'], url: null, pid: version.pid },
      { argv, url: URLS.video, pid: lookup.pid },
    ])
    for (const call of calls) expect(call.time).toBeTypeOf('number')
  })

  it("tries a test's own rules before the recorded ones", async () => {
    const ytdlp = await fake({
      manifestRules: [{ url: URLS.video, stderr: 'errors/youtube-private.log', exit: 1 }],
    })
    const overridden = await run(ytdlp.path, [...DUMP, '--', URLS.video])
    expect(overridden).toMatchObject({
      exitCode: 1,
      stderr: fixtureText('errors/youtube-private.log'),
    })
    const recorded = await run(ytdlp.path, [...DUMP, '--', URLS.set])
    expect(recorded.exitCode).toBe(0)
  })

  it("serves a test's own file by absolute path, with that rule's delay", async () => {
    const own = path.join(root, `own-${++cases}.json`)
    await writeFile(own, JSON.stringify({ _type: 'video', id: 'own', title: 'Ünïcode' }))
    const url = 'https://soundcloud.com/dj-scraper-fake/own'
    const ytdlp = await fake({ manifestRules: [{ url, stdout: own, delayMs: 200 }] })
    const result = await run(ytdlp.path, [...DUMP, '--', url])
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(200)
    expect(parseInfo(result.stdout)).toEqual({ _type: 'video', id: 'own', title: 'Ünïcode' })
  })

  it("hangs on a rule's own hang while other URLs still answer", async () => {
    const hanging = 'https://soundcloud.com/dj-scraper-fake/hangs'
    const ytdlp = await fake({
      manifestRules: [{ url: hanging, stdout: 'soundcloud/track.json', hang: true }],
    })
    const controller = new AbortController()
    const running = run(ytdlp.path, [...DUMP, '--', hanging], { signal: controller.signal })
    await ytdlp.waitForCalls(1)
    expect((await run(ytdlp.path, [...DUMP, '--', URLS.video])).exitCode).toBe(0)
    controller.abort()
    expect(await running).toMatchObject({ aborted: true, exitCode: 1 })
  })

  it('reads knobs from the environment when no file beside the link sets them', async () => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, ['--version'], {
      env: { ...process.env, FAKE_YTDLP_VERSION: '2026.08.19' },
    })
    expect(result.stdout).toBe('2026.08.19\n')
  })

  it.each([
    ['FAKE_YTDLP_HANG', 'true'],
    ['FAKE_YTDLP_DELAY_MS', '1.5'],
  ])('exits 2 on %s=%s instead of guessing', async (name, value) => {
    const ytdlp = await fake({ env: { [name]: value } })
    const result = await run(ytdlp.path, [...DUMP, '--', URLS.video])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(`fake-yt-dlp: ${name} must be`)
  })

  it('exits 2 on a manifest rule with a misspelled key', async () => {
    const ytdlp = await fake()
    const manifest = path.join(root, `bad-manifest-${++cases}.json`)
    await writeFile(manifest, JSON.stringify({ rules: [{ url: URLS.video, exitCode: 1 }] }))
    const result = await run(ytdlp.path, [...DUMP, '--', URLS.video], {
      env: { ...process.env, FAKE_YTDLP_MANIFEST: manifest },
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown keys exitCode')
  })
})

describe('fake yt-dlp: the recorded manifest', () => {
  /** Fixtures the manifest deliberately doesn't serve. */
  const WITHOUT_RULES: Record<string, string> = {
    'errors/interrupted.log': "the fake's own SIGINT answer, asserted in the hang test",
    'errors/ffmpeg-missing.log': 'download of a file:// source; download replay comes with Phase 2',
    'errors/postprocess-conversion.log':
      'download of a file:// source; download replay comes with Phase 2',
    'errors/postprocess-no-codec.log':
      'download of a file:// source; download replay comes with Phase 2',
  }
  /** Rule URLs that classifyUrl refuses: only a direct call could pass them to yt-dlp. */
  const NOT_FROM_THE_SERVER = new Set(['notaurl', 'https://music.amazon.com/albums/B0000000000'])
  const files = (rule: FakeYtdlpRule) =>
    [rule.stdout, rule.stderr].filter((file) => file !== undefined)

  it('points every rule at a fixture that exists', () => {
    for (const rule of MANIFEST_RULES) {
      for (const file of files(rule)) {
        expect(existsSync(path.join(FIXTURES, file)), `${rule.url}: ${file}`).toBe(true)
      }
    }
  })

  it('gives every recorded fixture a rule, or a reason it has none', () => {
    const referenced = new Set(MANIFEST_RULES.flatMap(files))
    const recorded = [
      ...readdirSync(path.join(FIXTURES, 'youtube')).map((name) => `youtube/${name}`),
      ...readdirSync(path.join(FIXTURES, 'soundcloud')).map((name) => `soundcloud/${name}`),
      ...readdirSync(path.join(FIXTURES, 'errors')).map((name) => `errors/${name}`),
    ].filter((file) => file.endsWith('.json') || file.endsWith('.log'))
    const uncovered = recorded.filter((file) => !referenced.has(file) && !(file in WITHOUT_RULES))
    expect(uncovered).toEqual([])
    for (const file of Object.keys(WITHOUT_RULES)) {
      expect(referenced.has(file), `${file} has a rule now`).toBe(false)
    }
  })

  it('matches each URL in the normalized form the server passes after --', () => {
    for (const rule of MANIFEST_RULES) {
      const classified = classifyUrl(rule.url)
      if (NOT_FROM_THE_SERVER.has(rule.url)) {
        expect(!classified.ok || classified.kind === 'out_of_scope', rule.url).toBe(true)
        continue
      }
      expect(classified.ok && classified.url, rule.url).toBe(rule.url)
      expect(classified.ok && classified.kind, rule.url).not.toBe('out_of_scope')
    }
  })

  it('serves each info document under the URL it was recorded with', () => {
    for (const rule of MANIFEST_RULES) {
      if (rule.stdout?.endsWith('.json')) {
        expect(fixtureInfo(rule.stdout).original_url, rule.stdout).toBe(rule.url)
      }
    }
  })

  // Built from each rule's own matchers: an earlier rule that shadowed it would answer instead.
  it.each(
    MANIFEST_RULES.map(
      (rule, index) => [`${index + 1} (${files(rule).join(' + ')})`, rule] as const,
    ),
  )('replays rule %s', async (_name, rule) => {
    const ytdlp = await fake()
    const isInfo = rule.stdout?.endsWith('.json') === true
    const argv = [
      ...BASE,
      ...(isInfo ? ['-J', '--flat-playlist'] : []),
      ...(rule.args ?? []).flatMap((group) => (typeof group === 'string' ? [group] : group)),
      ...(rule.playlist === undefined ? [] : [`--${rule.playlist}-playlist`]),
      '--',
      rule.url,
    ]
    const result = await run(ytdlp.path, argv)
    expect(result.exitCode).toBe(rule.exit ?? 0)
    expect(result.stderr).toBe(rule.stderr === undefined ? '' : fixtureText(rule.stderr))
    if (rule.stdout === undefined) expect(result.stdout).toBe('')
    else if (isInfo) expect(JSON.parse(result.stdout)).toEqual(fixtureInfo(rule.stdout))
    else expect(result.stdout).toBe(fixtureText(rule.stdout))
  })
})
