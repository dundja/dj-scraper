import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { classifyUrl } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killActiveGroups, type RunResult, run } from '../src/engine/run.ts'
import { downloadArgs, resolveArgs } from '../src/engine/ytdlp-args.ts'
import {
  FAKE_YTDLP,
  type FakeDownloadRule,
  type FakeYtdlp,
  type FakeYtdlpKnobs,
  type FakeYtdlpRule,
  fakeSourceHeader,
  makeTempDir,
  readFakeMedia,
  readFakeMediaFile,
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
/** The rules for -J calls, and those that replay a recorded download (fixtures/downloads). */
const INFO_RULES = MANIFEST_RULES.filter((rule) => rule.download === undefined)
const DOWNLOAD_RULES = MANIFEST_RULES.filter(
  (rule): rule is FakeDownloadRule => rule.download !== undefined,
)

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

  it('refuses to serve an info document to a call without -J that is no download either', async () => {
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

/** The design's START and DONE prints (§4), verbatim: the download fixtures were recorded with them. */
const START_PRINT =
  'before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j'
const DONE_PRINT =
  'after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j'
const DL_TEMPLATE = 'download:DL %(progress)j'
const PP_TEMPLATE = 'postprocess:PP %(progress.postprocessor)s %(progress.status)s'

/** The §4 download argv; `extra` goes where the platform flags go, before -P. */
function downloadArgv(
  url: string,
  jobDir: string,
  options: { selector?: string; thumbnail?: boolean; extra?: readonly string[] } = {},
): string[] {
  return [
    ...BASE,
    '--no-playlist',
    '-f',
    options.selector ?? 'ba',
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--retry-sleep',
    'fragment:exp=1:8',
    '--abort-on-unavailable-fragments',
    '--max-filesize',
    '2G',
    ...(options.thumbnail === false ? [] : ['--write-thumbnail']),
    ...(options.extra ?? []),
    '-P',
    jobDir,
    '-o',
    '%(id)s.%(ext)s',
    '--newline',
    '--progress',
    '--progress-delta',
    '0.5',
    '--progress-template',
    DL_TEMPLATE,
    '--progress-template',
    PP_TEMPLATE,
    '--print',
    START_PRINT,
    '--print',
    DONE_PRINT,
    '--',
    url,
  ]
}

/** A download call that matches `rule`: its own -f (else ba) and its other args. */
function ruleArgv(rule: FakeYtdlpRule, jobDir: string): string[] {
  const flat = (rule.args ?? []).flatMap((group) => (typeof group === 'string' ? [group] : group))
  const at = flat.indexOf('-f')
  if (at === -1) return downloadArgv(rule.url, jobDir, { extra: flat })
  const extra = [...flat.slice(0, at), ...flat.slice(at + 2)]
  return downloadArgv(rule.url, jobDir, { selector: flat[at + 1] ?? 'ba', extra })
}

/** Removes the first run of `tokens` from `argv`. */
function without(argv: readonly string[], tokens: readonly string[]): string[] {
  const at = argv.findIndex((_, i) => tokens.every((token, j) => argv[i + j] === token))
  return at === -1 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + tokens.length)]
}

const caseLog = (name: string, stream: 'stdout' | 'stderr'): string =>
  fixtureText(`downloads/${name}.${stream}.log`)

type Line = { stream: 'stdout' | 'stderr'; text: string }

/** Runs a download; with `abortAfter`, aborts (SIGINT to the group) once that many lines arrived. */
async function runDownload(
  ytdlp: FakeYtdlp,
  argv: readonly string[],
  abortAfter?: number,
): Promise<{ result: RunResult; lines: Line[] }> {
  const controller = new AbortController()
  const lines: Line[] = []
  const onLine = (stream: Line['stream']) => (text: string) => {
    lines.push({ stream, text })
    if (abortAfter !== undefined && lines.length >= abortAfter) controller.abort()
  }
  const result = await run(ytdlp.path, argv, {
    signal: controller.signal,
    onStdoutLine: onLine('stdout'),
    onStderrLine: onLine('stderr'),
  })
  return { result, lines }
}

/** A fresh job dir, as an attempt makes one. */
const newJobDir = async (name = `job-${++cases}`): Promise<string> => {
  const dir = path.join(root, name)
  await mkdir(dir, { mode: 0o700 })
  return dir
}

const listDir = async (dir: string): Promise<string[]> => (await readdir(dir)).sort()

/** The JSON of the line that starts with `prefix` (`DONE `, `START `). */
function lineJson(stdout: string, prefix: string): Record<string, unknown> {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix))
  if (line === undefined) throw new Error(`no ${prefix}line in ${stdout}`)
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
}

/**
 * Asserts that `actual` is the recorded log with {JOBDIR} filled in, and each {NOW+n} with the epoch
 * second of a moment in [from, to] (ms) plus n.
 */
function expectReplayed(
  actual: string,
  log: string,
  jobDir: string,
  window = { from: 0, to: Number.MAX_SAFE_INTEGER },
): void {
  const template = log.replaceAll('{JOBDIR}', jobDir)
  const parts = template.split(/\{NOW\+(\d+)\}/)
  const pattern = parts
    .map((part, i) => (i % 2 === 1 ? '(\\d+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  const values = (new RegExp(`^${pattern}$`).exec(actual) ?? []).slice(1).map(Number)
  let next = 0
  expect(actual).toBe(template.replace(/\{NOW\+\d+\}/g, (token) => String(values[next++] ?? token)))
  parts.forEach((part, i) => {
    if (i % 2 === 0) return
    const value = values[(i - 1) / 2] ?? Number.NaN
    expect(value).toBeGreaterThanOrEqual(Math.floor(window.from / 1000) + Number(part))
    expect(value).toBeLessThanOrEqual(Math.floor(window.to / 1000) + Number(part))
  })
}

const SC_FLAGS = ['--extractor-retries', '0', '--break-match-filters', 'format_id!*=preview']
const GO_PLUS = 'https://soundcloud.com/the-concept-band/world-on-fire-1'
const SC_AAC = 'https://soundcloud.com/the-concept-band/knocked-up-mastered'

describe('fake yt-dlp: downloads', () => {
  it('replays a recorded download byte for byte, with the job dir filled in', async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir()
    const { result } = await runDownload(ytdlp, downloadArgv(URLS.video, jobDir))
    expect(result.exitCode).toBe(0)
    expectReplayed(result.stdout, caseLog('youtube-ba', 'stdout'), jobDir)
    expectReplayed(result.stderr, caseLog('youtube-ba', 'stderr'), jobDir)
  })

  it('prints START and the DL lines, the PP lines after the finished one, then DONE', async () => {
    // A line delay puts every line into its own read, so the arrival order across stdout and
    // stderr is the order the fake wrote them in.
    const url = 'https://www.youtube.com/watch?v=DLORDER0001'
    const ytdlp = await fake({
      manifestRules: [{ url, download: 'youtube-m4a', lineDelayMs: 10 }],
    })
    const { result, lines } = await runDownload(ytdlp, downloadArgv(url, await newJobDir()))
    expect(result.exitCode).toBe(0)
    const kinds = lines.map(({ stream, text }) =>
      text.startsWith('PP ') ? `${stream} ${text}` : `${stream} ${text.split(' ')[0]}`,
    )
    expect(kinds).toEqual([
      'stdout START',
      'stdout DL',
      'stdout DL',
      'stderr PP FixupM4a started',
      'stderr PP FixupM4a finished',
      'stderr PP MoveFiles started',
      'stderr PP MoveFiles finished',
      'stdout DONE',
    ])
  })

  it('writes the files DONE names: FAKEAUDIO of the recorded source, a thumbnail with its magic', async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir()
    const { result } = await runDownload(ytdlp, downloadArgv(URLS.video, jobDir))
    const done = lineJson(result.stdout, 'DONE ')
    expect(done.filepath).toBe(path.join(jobDir, 'jNQXAC9IVRw.webm'))
    expect(done['thumbnails.-1.filepath']).toBe(path.join(jobDir, 'jNQXAC9IVRw.webp'))
    expect(await listDir(jobDir)).toEqual(['jNQXAC9IVRw.webm', 'jNQXAC9IVRw.webp'])

    const audio = await readFakeMediaFile(path.join(jobDir, 'jNQXAC9IVRw.webm'))
    expect(audio).toMatchObject({
      kind: 'audio',
      container: 'plain',
      header: fakeSourceHeader('ffprobe/src-youtube-251-webm.json'),
    })
    const thumbnail = await readFile(path.join(jobDir, 'jNQXAC9IVRw.webp'))
    expect(thumbnail.toString('latin1', 0, 4)).toBe('RIFF')
    expect(thumbnail.toString('latin1', 8, 12)).toBe('WEBP')
    expect(readFakeMedia(thumbnail)).toMatchObject({ kind: 'image', info: { format: 'webp' } })
  })

  it.each([
    [
      'soundcloud-ba',
      URLS.secretTrack,
      { audio: '123998367.mp3', image: '123998367.png' },
      [0x89, 0x50, 0x4e, 0x47],
      'ffprobe/src-soundcloud-mp3.json',
    ],
    [
      'soundcloud-hls-aac',
      SC_AAC,
      { audio: '47127631.m4a', image: '47127631.jpg' },
      [0xff, 0xd8, 0xff],
      'ffprobe/src-soundcloud-hls-aac-m4a.json',
    ],
  ])(
    'writes %s: a thumbnail with the magic of its extension, the audio as its probe',
    async (_case, url, { audio, image }, magic, probe) => {
      const ytdlp = await fake()
      const jobDir = await newJobDir()
      const { result } = await runDownload(ytdlp, downloadArgv(url, jobDir, { extra: SC_FLAGS }))
      expect(result.exitCode).toBe(0)
      expect(await listDir(jobDir)).toEqual([audio, image].sort())
      const bytes = await readFile(path.join(jobDir, image))
      expect([...bytes.subarray(0, magic.length)]).toEqual(magic)
      expect(await readFakeMediaFile(path.join(jobDir, audio))).toMatchObject({
        header: fakeSourceHeader(probe),
      })
    },
  )

  it('leaves the thumbnail out of DONE and of the job dir without --write-thumbnail', async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir()
    const argv = downloadArgv(URLS.video, jobDir, { thumbnail: false })
    const { result } = await runDownload(ytdlp, argv)
    const recorded = caseLog('youtube-ba', 'stdout').replace(
      ', "thumbnails.-1.filepath": "{JOBDIR}/jNQXAC9IVRw.webp"',
      '',
    )
    expectReplayed(result.stdout, recorded, jobDir)
    expect(await listDir(jobDir)).toEqual(['jNQXAC9IVRw.webm'])
  })

  it("escapes a non-ASCII job dir in the JSON lines like yt-dlp's %()j", async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir(`jöb-${++cases}`)
    const { result } = await runDownload(ytdlp, downloadArgv(URLS.video, jobDir))
    expect(result.stdout).toMatch(/^[\x20-\x7e\n]+$/)
    expect(result.stdout).toContain('j\\u00f6b-')
    const done = lineJson(result.stdout, 'DONE ')
    expect(done.filepath).toBe(path.join(jobDir, 'jNQXAC9IVRw.webm'))
    expect(existsSync(path.join(jobDir, 'jNQXAC9IVRw.webm'))).toBe(true)
  })

  it('fills {NOW+n} in with the epoch second and waits FAKE_YTDLP_WAIT_MS for the site', async () => {
    const ytdlp = await fake({ env: { FAKE_YTDLP_WAIT_MS: '150' } })
    const jobDir = await newJobDir()
    const from = Date.now()
    const argv = downloadArgv('https://www.youtube.com/watch?v=DLWAITING01', jobDir)
    const { result } = await runDownload(ytdlp, argv)
    const to = Date.now()
    expect(result.exitCode).toBe(0)
    expectReplayed(result.stdout, caseLog('youtube-ba-wait', 'stdout'), jobDir, { from, to })
    // START says available_at = now + 3 s; the knob's 150 ms replace yt-dlp's 3 s sleep.
    expect(result.durationMs).toBeGreaterThanOrEqual(150)
    expect(result.durationMs).toBeLessThan(2_000)
  })

  it('hangs after hangAfter lines with the .part written, and answers SIGINT like the recording', async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir()
    const argv = downloadArgv('https://www.youtube.com/watch?v=DLCANCEL001', jobDir)
    const { result } = await runDownload(ytdlp, argv, 3)
    expect(result).toMatchObject({
      aborted: true,
      exitCode: 1,
      stderr: caseLog('youtube-cancel-download', 'stderr'),
    })
    expectReplayed(result.stdout, caseLog('youtube-cancel-download', 'stdout'), jobDir)
    expect(await listDir(jobDir)).toEqual(['jNQXAC9IVRw.webm.part'])
  })

  it('keeps the finished download when it hangs in a fixup', async () => {
    const ytdlp = await fake()
    const jobDir = await newJobDir()
    const argv = downloadArgv('https://www.youtube.com/watch?v=DLCANCELFIX', jobDir)
    const { result } = await runDownload(ytdlp, argv, 4)
    expect(result).toMatchObject({
      aborted: true,
      exitCode: 1,
      stderr: caseLog('youtube-cancel-fixup', 'stderr'),
    })
    expect(await listDir(jobDir)).toEqual(['jNQXAC9IVRw.m4a'])
    expect(await readFakeMediaFile(path.join(jobDir, 'jNQXAC9IVRw.m4a'))).toMatchObject({
      header: fakeSourceHeader('ffprobe/src-youtube-140-m4a.json'),
    })
  })

  it('leaves the .part and .ytdl of a failed fragment download, and replaces them once finished', async () => {
    const ytdlp = await fake()
    const failedDir = await newJobDir()
    const failed = await runDownload(
      ytdlp,
      downloadArgv('http://127.0.0.1:4799/missing/master.m3u8', failedDir, {
        selector: 'ba/b',
        extra: ['--match-filters', '!is_live'],
      }),
    )
    expect(failed.result).toMatchObject({
      exitCode: 1,
      stderr: caseLog('local-hls-404', 'stderr'),
    })
    expect(await listDir(failedDir)).toEqual(['master.mp4.part', 'master.mp4.ytdl'])

    const finishedDir = await newJobDir()
    const url = 'https://soundcloud.com/dj-scraper-fake/hls-mp3'
    const finished = await runDownload(ytdlp, downloadArgv(url, finishedDir, { extra: SC_FLAGS }))
    expect(finished.result.exitCode).toBe(0)
    expect(await listDir(finishedDir)).toEqual(['123998367.mp3', '123998367.png'])
  })

  it.each([
    ['youtube', 'mp3', URLS.video, 0, 'jNQXAC9IVRw.webm'],
    ['youtube', 'm4a', URLS.video, 0, 'jNQXAC9IVRw.m4a'],
    ['youtube', 'wav', URLS.video, 0, 'jNQXAC9IVRw.webm'],
    ['soundcloud', 'aiff', URLS.secretTrack, 0, '123998367.mp3'],
    ['soundcloud', 'm4a', SC_AAC, 0, '47127631.m4a'],
    ['soundcloud', 'mp3', GO_PLUS, 101, undefined],
    ['other', 'original', 'http://127.0.0.1:4799/flaky/tone.mp3', 1, undefined],
  ] as const)(
    'answers the argv downloadArgs builds for %s %s',
    async (platform, format, url, exit, file) => {
      const ytdlp = await fake()
      const jobDir = await newJobDir()
      const argv = downloadArgs({
        url,
        platform,
        format,
        jobDir,
        writeThumbnail: format !== 'wav',
        jsRuntime: process.execPath,
      })
      const { result } = await runDownload(ytdlp, argv)
      expect(result.exitCode, result.stderr).toBe(exit)
      if (file !== undefined) {
        expect(lineJson(result.stdout, 'DONE ').filepath).toBe(path.join(jobDir, file))
      }
    },
  )

  it('answers a download that fails before downloading with the recorded extraction error', async () => {
    const ytdlp = await fake()
    const { result } = await runDownload(ytdlp, downloadArgv(URLS.private, await newJobDir()))
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: fixtureText('errors/youtube-private.log'),
    })
  })

  it('serves downloads only from download rules, and -J calls never from them', async () => {
    const ytdlp = await fake()
    const lookupOnly = 'https://music.youtube.com/watch?v=XNEnEBrHws8'
    const download = await runDownload(ytdlp, downloadArgv(lookupOnly, await newJobDir()))
    expect(download.result).toMatchObject({
      exitCode: 1,
      stderr: `ERROR: Unsupported URL: ${lookupOnly}\n`,
    })
    const downloadOnly = 'https://www.youtube.com/watch?v=DLWAITING01'
    const lookup = await run(ytdlp.path, [...DUMP, '--no-playlist', '--', downloadOnly])
    expect(lookup).toMatchObject({
      exitCode: 1,
      stderr: `ERROR: Unsupported URL: ${downloadOnly}\n`,
    })
  })

  it('treats a -J call as a lookup even when it has -P and the DONE print', async () => {
    const ytdlp = await fake()
    const argv = [...DUMP, '--no-playlist', '-P', root, '--print', DONE_PRINT, '--', URLS.video]
    const result = await run(ytdlp.path, argv)
    expect(result.exitCode).toBe(0)
    expect(parseInfo(result.stdout).id).toBe('jNQXAC9IVRw')
  })

  it("gives a test's rule for a recorded case that case's recorded exit code", async () => {
    const url = 'https://soundcloud.com/dj-scraper-fake/own-preview'
    const ytdlp = await fake({
      manifestRules: [{ url, download: 'soundcloud-preview-break' }],
    })
    const { result } = await runDownload(ytdlp, downloadArgv(url, await newJobDir()))
    expect(result).toMatchObject({ exitCode: 101, stdout: '', stderr: '' })
  })

  it("replays a test's own case by its absolute prefix, with the rule's probe and line delay", async () => {
    const prefix = path.join(root, `own-case-${++cases}`)
    const stdout = [
      'START {"format_id": "251", "acodec": "opus", "abr": 106.064, "protocol": "https"}',
      'DL {"downloaded_bytes": 9, "total_bytes": 9, "filename": "{JOBDIR}/own.opus", "status": "finished"}',
      'DONE {"id": "own", "filepath": "{JOBDIR}/own.opus", "ext": "opus", "acodec": "opus"}',
    ]
    await writeFile(`${prefix}.stdout.log`, `${stdout.join('\n')}\n`)
    await writeFile(`${prefix}.stderr.log`, '')
    const url = 'https://soundcloud.com/dj-scraper-fake/own-case'
    const probe = 'ffprobe/src-youtube-251-webm.json'
    const ytdlp = await fake({
      manifestRules: [{ url, download: prefix, probe, lineDelayMs: 40 }],
    })
    const jobDir = await newJobDir()
    const { result } = await runDownload(ytdlp, downloadArgv(url, jobDir))
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(80)
    expect(await readFakeMediaFile(path.join(jobDir, 'own.opus'))).toMatchObject({
      header: fakeSourceHeader(probe),
    })
  })

  it('exits 2 when a finished file matches no recorded source and the rule names no probe', async () => {
    const prefix = path.join(root, `own-case-${++cases}`)
    const done =
      'DONE {"id": "own", "filepath": "{JOBDIR}/own.ogg", "ext": "ogg", "acodec": "vorbis"}'
    await writeFile(`${prefix}.stdout.log`, `${done}\n`)
    await writeFile(`${prefix}.stderr.log`, '')
    const url = 'https://soundcloud.com/dj-scraper-fake/own-ogg'
    const ytdlp = await fake({ manifestRules: [{ url, download: prefix }] })
    const { result } = await runDownload(ytdlp, downloadArgv(url, await newJobDir()))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('no default probe for a .ogg vorbis download')
  })

  const FULL = downloadArgv(URLS.video, '/tmp/dj-scraper-job')
  it.each([
    ['--no-playlist', without(FULL, ['--no-playlist'])],
    ['--abort-on-unavailable-fragments', without(FULL, ['--abort-on-unavailable-fragments'])],
    ['-o %(id)s.%(ext)s', without(FULL, ['-o', '%(id)s.%(ext)s'])],
    ['--newline', without(FULL, ['--newline'])],
    ['--progress', without(FULL, ['--progress'])],
    ['the DL progress template', without(FULL, ['--progress-template', DL_TEMPLATE])],
    ['the PP progress template', without(FULL, ['--progress-template', PP_TEMPLATE])],
    ['the START print', without(FULL, ['--print', START_PRINT])],
    ['-f', without(FULL, ['-f', 'ba'])],
  ])('exits 2 on a download without %s', async (_missing, argv) => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, argv)
    expect(result).toMatchObject({ exitCode: 2, stdout: '' })
    expect(result.stderr).toMatch(/^fake-yt-dlp: a download needs .+\n$/)
  })

  it.each([
    [
      'a DONE print with other fields',
      FULL.map((token) => (token === DONE_PRINT ? 'after_move:DONE %(id)s' : token)),
      'a download needs --print after_move:DONE',
    ],
    [
      'a relative -P',
      FULL.map((token) => (token === '/tmp/dj-scraper-job' ? 'job' : token)),
      '-P needs an absolute job dir',
    ],
    [
      '--yes-playlist after --no-playlist',
      [...FULL.slice(0, -2), '--yes-playlist', '--', URLS.video],
      'a download needs --no-playlist',
    ],
  ])('exits 2 on a download with %s', async (_why, argv, message) => {
    const ytdlp = await fake()
    const result = await run(ytdlp.path, argv)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(message)
  })

  it.each([
    ['a download rule with stdout', { download: 'youtube-ba', stdout: 'youtube/video.json' }],
    ['a probe without download', { stdout: 'youtube/video.json', probe: 'ffprobe/out-wav.json' }],
    ['a case name that is a path', { download: '../errors/youtube-private' }],
    ['a negative hangAfter', { download: 'youtube-ba', hangAfter: -1 }],
  ])('exits 2 on %s', async (_why, rule) => {
    const ytdlp = await fake({ manifestRules: [{ url: URLS.video, ...rule }] })
    const result = await run(ytdlp.path, downloadArgv(URLS.video, await newJobDir()))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('invalid rule')
  })

  it("exits 2 when hangAfter is past the case's last line", async () => {
    const url = 'https://soundcloud.com/dj-scraper-fake/hang-too-late'
    const ytdlp = await fake({
      manifestRules: [{ url, download: 'soundcloud-list-break', hangAfter: 4 }],
    })
    const { result } = await runDownload(ytdlp, downloadArgv(url, await newJobDir()))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hangAfter 4, but the case has 3 lines')
  })
})

describe('fake yt-dlp: the recorded manifest', () => {
  /** Fixtures the manifest deliberately doesn't serve. */
  const WITHOUT_RULES: Record<string, string> = {
    'errors/interrupted.log': "the fake's own SIGINT answer, asserted in the hang test",
    'errors/ffmpeg-missing.log':
      "yt-dlp's -x ExtractAudio failing on a file:// download; §4 downloads don't extract (D1)",
    'errors/postprocess-conversion.log':
      "yt-dlp's -x ExtractAudio failing on a file:// download; §4 downloads don't extract (D1)",
    'errors/postprocess-no-codec.log':
      "yt-dlp's -x ExtractAudio failing on a file:// download; §4 downloads don't extract (D1)",
    'errors/local-cut.log': 'a §4 download from a local server that cuts it; for the error mapper',
    'errors/local-no-data.log': 'a §4 download of an empty body; for the error mapper',
    'errors/local-enospc-write.log': 'a §4 download onto a full disk image; for the error mapper',
    'errors/local-enospc-open.log': 'a §4 download onto a full disk image; for the error mapper',
    'errors/local-enospc-hls.log': 'a §4 HLS download onto a full disk image; for the error mapper',
    'downloads/local-hls-missing':
      'pre-§4 -x argv: its DL/PP/DONE lines are not what §4 prints; kept for the error mapper',
    'downloads/local-hls-missing-noquiet':
      'pre-§4 -x argv with --no-quiet: kept for the error mapper (a skipped fragment)',
    'downloads/local-hls-missing-abort':
      'pre-§4 -x argv: kept for the error mapper; local-hls-404 is its §4 recording',
    'downloads/local-hls-429-abort-r1':
      'pre-§4 -x argv: kept for the error mapper; local-hls-429 is its §4 recording',
    'downloads/local-http-429':
      'pre-§4 -x argv: kept for the error mapper; local-progressive-429 is its §4 recording',
  }
  /** Rule URLs that classifyUrl refuses: only a direct call could pass them to yt-dlp. */
  const NOT_FROM_THE_SERVER = new Set(['notaurl', 'https://music.amazon.com/albums/B0000000000'])
  const files = (rule: FakeYtdlpRule) =>
    [
      rule.stdout,
      rule.stderr,
      rule.probe,
      ...(rule.download === undefined
        ? []
        : [`downloads/${rule.download}.stdout.log`, `downloads/${rule.download}.stderr.log`]),
    ].filter((file) => file !== undefined)

  it('points every rule at a fixture that exists', () => {
    for (const rule of MANIFEST_RULES) {
      for (const file of files(rule)) {
        expect(existsSync(path.join(FIXTURES, file)), `${rule.url}: ${file}`).toBe(true)
      }
    }
  })

  it('gives every recorded fixture a rule, or a reason it has none', () => {
    const referenced = new Set([
      ...MANIFEST_RULES.flatMap(files),
      ...DOWNLOAD_RULES.map((rule) => `downloads/${rule.download}`),
    ])
    const downloads = readdirSync(path.join(FIXTURES, 'downloads'))
    const recorded = [
      ...readdirSync(path.join(FIXTURES, 'youtube')).map((name) => `youtube/${name}`),
      ...readdirSync(path.join(FIXTURES, 'soundcloud')).map((name) => `soundcloud/${name}`),
      ...readdirSync(path.join(FIXTURES, 'errors')).map((name) => `errors/${name}`),
    ].filter((file) => file.endsWith('.json') || file.endsWith('.log'))
    const recordedCases = downloads
      .filter((name) => name.endsWith('.stdout.log'))
      .map((name) => `downloads/${name.slice(0, -'.stdout.log'.length)}`)
    const uncovered = [...recorded, ...recordedCases].filter(
      (file) => !referenced.has(file) && !(file in WITHOUT_RULES),
    )
    expect(uncovered).toEqual([])
    for (const file of Object.keys(WITHOUT_RULES)) {
      expect(referenced.has(file), `${file} has a rule now`).toBe(false)
    }
    // Every case is a pair, and nothing else lives there but the README.
    const pairs = recordedCases.flatMap((name) => [
      `${path.basename(name)}.stdout.log`,
      `${path.basename(name)}.stderr.log`,
    ])
    expect(downloads.filter((name) => name !== 'README.md').sort()).toEqual(pairs.sort())
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

  it('serves each download case under a URL the server downloads: not a collection', () => {
    for (const rule of DOWNLOAD_RULES) {
      const classified = classifyUrl(rule.url)
      expect(classified.ok && classified.guess, rule.url).not.toBe('collection')
    }
  })

  it('serves each info document under the URL it was recorded with', () => {
    for (const rule of INFO_RULES) {
      if (rule.stdout?.endsWith('.json')) {
        expect(fixtureInfo(rule.stdout).original_url, rule.stdout).toBe(rule.url)
      }
    }
  })

  it('gives each download rule its recorded exit, and hangs only where the recording was interrupted', () => {
    const interrupted = fixtureText('errors/interrupted.log')
    for (const rule of DOWNLOAD_RULES) {
      expect(rule.exit, rule.download).toBeTypeOf('number')
      const stderr = caseLog(rule.download, 'stderr')
      expect(rule.hangAfter !== undefined, rule.download).toBe(stderr.endsWith(interrupted))
    }
  })

  // Built from each rule's own matchers: an earlier rule that shadowed it would answer instead.
  it.each(
    INFO_RULES.map((rule, index) => [`${index + 1} (${files(rule).join(' + ')})`, rule] as const),
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

  it.each(DOWNLOAD_RULES.map((rule) => [`${rule.download} (${rule.url})`, rule] as const))(
    'replays download %s',
    async (_name, rule) => {
      const ytdlp = await fake({ env: { FAKE_YTDLP_WAIT_MS: '0' } })
      const jobDir = await newJobDir()
      const from = Date.now()
      const { result } = await runDownload(ytdlp, ruleArgv(rule, jobDir), rule.hangAfter)
      const window = { from, to: Date.now() }
      expect(result.exitCode).toBe(rule.exit)
      expect(result.aborted).toBe(rule.hangAfter !== undefined)
      expectReplayed(result.stdout, caseLog(rule.download, 'stdout'), jobDir, window)
      expectReplayed(result.stderr, caseLog(rule.download, 'stderr'), jobDir, window)
      if (!result.stdout.includes('DONE ')) return
      const done = lineJson(result.stdout, 'DONE ')
      expect(await readFakeMediaFile(String(done.filepath))).toMatchObject({ kind: 'audio' })
      const thumbnail = done['thumbnails.-1.filepath']
      if (thumbnail !== undefined) {
        expect(await readFakeMediaFile(String(thumbnail))).toMatchObject({ kind: 'image' })
      }
    },
  )
})
