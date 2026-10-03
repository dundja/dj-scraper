// The server that apps/web's Playwright config runs as its webServer:
//
//   PORT=4849 node <repo>/apps/server/test/e2e-server.ts      (from any cwd)
//
// - Runs the real entry (src/index.ts) in production mode, without --dev or --open, serving the
//   built UI from apps/web/dist, or from DJS_WEB_DIST if set (absolute). Exits 1 if there is none.
// - The engine is the fake one (writeFakeEngine): yt-dlp (today's version) replays the recorded
//   fixtures for resolve, entry lookups and downloads, and ffmpeg/ffprobe finalize the fake audio it
//   leaves. Their temp dir, with a `node` link for the fakes' `#!/usr/bin/env node`, is the server's
//   whole PATH, so GET /api/health is ok, with node as the JS runtime. Nothing real is found and
//   nothing touches the network. apps/web/e2e/fake-urls.ts lists the URLs it answers.
// - On top of the recorded rules (fixtures/fake-yt-dlp.json), the fake gets the rules e2eRules
//   writes, tried first: downloads for every row of the e2e playlist and the watch+list and mix
//   tracks, made from the one recorded YouTube download, so a UI flow can download more than one
//   video; set row 6's download by the API URL the set lists it with; and three made-up links for
//   UI states no recording shows: a list that takes SLOW_RESOLVE_MS to load, a video whose
//   download hangs until it is canceled, and a private video in the recorded playlist (its track
//   lookup fails while the list loads). apps/web/e2e/fake-urls.ts lists them.
// - Its data dir (DJS_DATA_DIR) and home folder (HOME) are in the same temp dir, so it never touches
//   the user's ~/Library/Application Support/DJ Scraper or ~/Music. Downloads go to the default
//   folder, the temp HOME's Music/DJ Scraper, which the first download creates.
// - SIGINT, SIGTERM and SIGHUP are passed on to the server. When it exits, the temp dir is removed
//   and this script exits with the server's code.
//
// The server is spawned here directly, not through run(): run() puts it in its own process group,
// so a signal or SIGKILL to this script's group (Ctrl-C, Playwright's teardown) would miss it and
// leave the port taken. In this group it gets those signals as well.
import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:os'
import path from 'node:path'
import { PortSchema } from '@dj-scraper/shared'
import { z } from 'zod'
import { DEFAULT_WEB_DIST } from '../src/config.ts'
import { hasBuiltUi } from '../src/routes/web.ts'
import {
  type FakeDownloadRule,
  type FakeYtdlpRule,
  makeTempDir,
  SERVER_DIR,
  serverEnv,
  todaysYtdlpVersion,
  writeFakeEngine,
} from './helpers.ts'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

/** The recorded fixtures whose rows e2e downloads: a playlist's entries, or the video itself. */
const DOWNLOADABLE = [
  'youtube/playlist-unavailable-entries.json',
  'youtube/watch-list-track.json',
  'youtube/mix-track.json',
]

/**
 * A row's download sleeps this long before each line after the first, so the UI shows it starting,
 * downloading and processing for about a second and a half. The recorded rules replay at once.
 */
const ROW_LINE_DELAY_MS = 250

/**
 * The recorded downloads of jNQXAC9IVRw a row's download is made from, by the selector the format
 * asks for (M4A, else `ba`), with the source each one's file probes as.
 */
const TEMPLATES = [
  {
    name: 'youtube-m4a',
    args: [['-f', 'ba[ext=m4a]/ba']],
    probe: 'ffprobe/src-youtube-140-m4a.json',
  },
  { name: 'youtube-ba', args: [], probe: 'ffprobe/src-youtube-251-webm.json' },
] as const
const TEMPLATE_ID = 'jNQXAC9IVRw'

/**
 * Set row 6 (soundcloud/set.json) is listed by its API URL, so a download before its lookup filled
 * the row in passes that URL. yt-dlp downloads it like the page URL the recording used.
 */
const SET_ROW_BY_API_URL: FakeDownloadRule = {
  url: 'https://api-v2.soundcloud.com/tracks/47127631',
  download: 'soundcloud-hls-aac',
  probe: 'ffprobe/src-soundcloud-hls-aac-m4a.json',
  note: 'e2e: the recording of its page URL, the-concept-band/knocked-up-mastered',
}

/**
 * How long the slow list takes to load: past the UI's 3 s before it shows the elapsed seconds and
 * the big-list note, with room for a spec to see them and press Cancel (which stops yt-dlp).
 */
const SLOW_RESOLVE_MS = 20_000

/** A playlist that loads (the 4 rows of youtube/playlist-capped.json) only after SLOW_RESOLVE_MS. */
const SLOW_PLAYLIST: FakeYtdlpRule = {
  url: 'https://www.youtube.com/playlist?list=PLdjScraperE2eSlowList',
  stdout: 'youtube/playlist-capped.json',
  delayMs: SLOW_RESOLVE_MS,
  note: 'e2e: made-up URL, the recorded capped playlist after a delay',
}

/**
 * The private video bM7SZ5SBzyY opened inside the recorded "dlp test playlist": the track lookup
 * (`--no-playlist`) fails as the private video does, and the list itself loads, since the server
 * lists a watch+list link's list at its /playlist?list=… URL (youtube/playlist.json).
 */
const PRIVATE_IN_PLAYLIST: FakeYtdlpRule = {
  url: 'https://www.youtube.com/watch?v=bM7SZ5SBzyY&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  playlist: 'no',
  stderr: 'errors/youtube-private.log',
  exit: 1,
  note: 'e2e: made-up pairing of the private video with the recorded playlist',
}

/** A made-up video whose download hangs until it is canceled (or SIGINTed). */
const HANGING_ID = 'e2eHangs001'
const HANGING_URL = `https://www.youtube.com/watch?v=${HANGING_ID}`
const HANGING_TITLE = 'Endless Download (e2e)'
const HANGING_UPLOADER = 'DJ Scraper e2e'
const HANGING_DURATION_SEC = 245

/**
 * The hanging video's rules: its -J answer, youtube/video.json renamed (written to `dir`), and its
 * download, the recorded canceled run (`youtube-cancel-download`: START and two progress lines, 12 %
 * done), which hangs after those lines until SIGINT and then exits 1 as yt-dlp does. Any format.
 */
async function hangingRules(dir: string): Promise<FakeYtdlpRule[]> {
  const info = JsonObject.parse(JSON.parse(readFixture('youtube/video.json')))
  const file = path.join(dir, `${HANGING_ID}.info.json`)
  await writeFile(
    file,
    JSON.stringify({
      ...info,
      id: HANGING_ID,
      display_id: HANGING_ID,
      title: HANGING_TITLE,
      fulltitle: HANGING_TITLE,
      duration: HANGING_DURATION_SEC,
      duration_string: '4:05',
      uploader: HANGING_UPLOADER,
      channel: HANGING_UPLOADER,
      chapters: null,
      webpage_url: HANGING_URL,
      original_url: HANGING_URL,
    }),
  )
  return [
    { url: HANGING_URL, stdout: file, note: 'e2e: youtube/video.json as the hanging video' },
    {
      url: HANGING_URL,
      download: 'youtube-cancel-download',
      hangAfter: 3,
      exit: 1,
      note: 'e2e: hangs after the second progress line until canceled',
    },
  ]
}

/** A null name is left out of DONE, as yt-dlp leaves out missing keys. */
const Name = z
  .string()
  .nullish()
  .transform((name) => name ?? undefined)

/** A row yt-dlp can download. The private and deleted rows have no duration, so they're left out. */
const RowSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  url: z.url(),
  title: z.string(),
  duration: z.number().positive(),
  uploader: Name,
  channel: Name,
})
type Row = z.infer<typeof RowSchema>

const readFixture = (file: string): string => readFileSync(path.join(FIXTURES, file), 'utf8')
const JsonObject = z.record(z.string(), z.unknown())
const ProbeSchema = z.looseObject({ format: JsonObject })

function rowsOf(fixture: string): Row[] {
  const info = JsonObject.parse(JSON.parse(readFixture(fixture)))
  const items = info._type === 'playlist' ? z.array(JsonObject).parse(info.entries) : [info]
  return items.flatMap((item) => {
    const row = RowSchema.safeParse({ ...item, url: item.webpage_url ?? item.url })
    return row.success ? [row.data] : []
  })
}

/**
 * The template's run with the row's id, and its DONE line with the row's title, uploader and
 * duration. The file probes as the template's source, at the row's duration.
 */
async function writeRowCase(dir: string, template: (typeof TEMPLATES)[number], row: Row) {
  const prefix = path.join(dir, `${row.id}.${template.name}`)
  const read = (stream: string) =>
    readFixture(`downloads/${template.name}.${stream}.log`).replaceAll(TEMPLATE_ID, row.id)
  const stdout = read('stdout')
    .split('\n')
    .map((line) => {
      if (!line.startsWith('DONE ')) return line
      const { title, duration, uploader, channel } = row
      const done = JsonObject.parse(JSON.parse(line.slice('DONE '.length)))
      return `DONE ${JSON.stringify({ ...done, title, duration, uploader, channel })}`
    })
    .join('\n')
  const probe = ProbeSchema.parse(JSON.parse(readFixture(template.probe)))
  const probeFile = `${prefix}.probe.json`
  await writeFile(`${prefix}.stdout.log`, stdout)
  await writeFile(`${prefix}.stderr.log`, read('stderr'))
  await writeFile(
    probeFile,
    JSON.stringify({ ...probe, format: { ...probe.format, duration: row.duration.toFixed(6) } }),
  )
  return { prefix, probeFile }
}

/**
 * The e2e rules, their files written to `dir`: the UI states no recording shows (the slow list, the
 * private track in a playlist, the hanging download), then downloads for the set row and for every
 * row of DOWNLOADABLE.
 */
async function e2eRules(dir: string): Promise<FakeYtdlpRule[]> {
  await mkdir(dir)
  const rows = new Map(DOWNLOADABLE.flatMap(rowsOf).map((row) => [row.url, row]))
  const rules: FakeYtdlpRule[] = [
    SLOW_PLAYLIST,
    PRIVATE_IN_PLAYLIST,
    ...(await hangingRules(dir)),
    SET_ROW_BY_API_URL,
  ]
  for (const row of rows.values()) {
    for (const template of TEMPLATES) {
      const { prefix, probeFile } = await writeRowCase(dir, template, row)
      rules.push({
        url: row.url,
        args: template.args,
        download: prefix,
        probe: probeFile,
        lineDelayMs: ROW_LINE_DELAY_MS,
        note: `e2e: ${template.name} as ${row.id}`,
      })
    }
  }
  return rules
}

function fail(message: string): never {
  console.error(`[e2e-server] ${message}`)
  process.exit(1)
}

const exitCodeFor = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 1 : 128 + constants.signals[signal])

const port = PortSchema.safeParse(process.env.PORT ?? '')
if (!port.success) fail('Set PORT to a free port from 1024 to 65535, e.g. PORT=4849.')

const webDist = process.env.DJS_WEB_DIST || DEFAULT_WEB_DIST
if (!path.isAbsolute(webDist)) fail(`DJS_WEB_DIST must be an absolute path, not ${webDist}.`)
if (!hasBuiltUi(webDist)) {
  fail(`No built UI in ${webDist}. Run \`pnpm --filter @dj-scraper/web build\` first.`)
}

let server: ChildProcess | undefined
const running = () => server !== undefined && server.exitCode === null && server.signalCode === null

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    // Still setting up: nothing to stop, the exit hook removes the temp dir.
    if (server === undefined) process.exit(exitCodeFor(null, signal))
    if (running()) server.kill(signal)
  })
}

const tempDir = await makeTempDir('e2e')
process.on('exit', () => {
  if (running()) server?.kill('SIGKILL')
  rmSync(tempDir, { recursive: true, force: true })
})

const bin = path.join(tempDir, 'bin')
await writeFakeEngine(bin, {
  ytdlpRules: await e2eRules(path.join(tempDir, 'downloads')),
  ytdlpEnv: { FAKE_YTDLP_VERSION: todaysYtdlpVersion() },
})
// The fakes are Node scripts, and PATH is this dir alone.
await symlink(process.execPath, path.join(bin, 'node'))
const dirs = await serverEnv(tempDir)
console.log(`[e2e-server] Fake engine in ${bin}, UI from ${webDist}`)

server = spawn(process.execPath, ['src/index.ts'], {
  cwd: SERVER_DIR,
  env: { PATH: bin, PORT: String(port.data), DJS_WEB_DIST: webDist, ...dirs },
  stdio: ['ignore', 'inherit', 'inherit'],
})
server.once('error', (error) => fail(`Cannot start the server: ${error.message}`))
server.once('exit', (code, signal) => process.exit(exitCodeFor(code, signal)))
