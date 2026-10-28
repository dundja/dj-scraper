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
// - Spotify (ADR-026) is a local fixture server (startSpotifyFixtures: the scrubbed embed pages of
//   test/fixtures/spotify, every cover rewritten to it), passed to the server as
//   DJS_SPOTIFY_ORIGIN, so a Spotify link resolves and no cover comes from Spotify's CDN. Every row
//   of the Spotify album downloads (spotifyAlbumRules): row 1 is the recorded track and search,
//   rows 2-10 get synthetic track pages, searches and downloads made from the recordings.
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
import { normalizeEntry } from '../src/engine/ytdlp-parse.ts'
import { parseSearchResults, remixQuery, SEARCH_COUNTS, songOf } from '../src/remix/suggest.ts'
import { checkUrl } from '../src/resolve/input.ts'
import { hasBuiltUi } from '../src/routes/web.ts'
import { parseEmbedPage } from '../src/spotify/embed.ts'
import { SEARCH_RESULTS, searchQuery } from '../src/spotify/match.ts'
import {
  type FakeDownloadRule,
  type FakeYtdlpRule,
  makeTempDir,
  SERVER_DIR,
  serverEnv,
  startSpotifyFixtures,
  todaysYtdlpVersion,
  writeFakeEngine,
  youtubeDownloadRules,
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

function rowsOf(fixture: string): Row[] {
  const info = JsonObject.parse(JSON.parse(readFixture(fixture)))
  const items = info._type === 'playlist' ? z.array(JsonObject).parse(info.entries) : [info]
  return items.flatMap((item) => {
    const row = RowSchema.safeParse({ ...item, url: item.webpage_url ?? item.url })
    return row.success ? [row.data] : []
  })
}

/**
 * The single tracks the specs paste whose remix searches (ADR-027) nobody recorded: each link and
 * the -J answer it resolves with (relative to test/fixtures, or absolute). The mix's seed video
 * and the Spotify track have recorded searches (fake-yt-dlp.json).
 */
const SINGLE_TRACKS: readonly { url: string; info: string }[] = [
  { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', info: 'youtube/video.json' },
  {
    url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
    info: 'soundcloud/track-secret.json',
  },
  {
    url: 'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
    info: 'youtube/watch-list-track.json',
  },
]

/**
 * The one remix search left failing, for the UI's per-platform error and its Try again: the
 * SoundCloud track's SoundCloud search. With no rule the fake exits 2, so the answer's
 * `searches.soundcloud` is `error` (`unknown`) and its YouTube search is empty.
 */
const FAILING_REMIX_SEARCH = { url: SINGLE_TRACKS[1]?.url, site: 'soundcloud' } as const

/**
 * Empty remix searches for each of `tracks`, on both platforms, so their remix sections show "No
 * remixes found" instead of an error (but FAILING_REMIX_SEARCH). The query is the one the server
 * builds: the track as resolve gives it (normalizeEntry), its song (songOf) and remixQuery, so it
 * follows any change to them. The empty answers are the recorded searches with no entries.
 */
async function emptyRemixRules(
  dir: string,
  tracks: readonly { url: string; info: string }[],
): Promise<FakeYtdlpRule[]> {
  const sites = {
    youtube: { prefix: 'ytsearch', recorded: 'youtube/search-remixes-never-gonna.json' },
    soundcloud: { prefix: 'scsearch', recorded: 'soundcloud/search-remixes-never-gonna.json' },
  } as const
  const rules: FakeYtdlpRule[] = []
  for (const [index, { url, info }] of tracks.entries()) {
    const input = checkUrl(url)
    if (!input.ok) throw new Error(`not a valid link: ${url}`)
    const track = normalizeEntry(JSON.parse(readFile(info)), input.input)
    const song = songOf(track)
    if (song === undefined) throw new Error(`nothing to search remixes of for ${url}`)
    const query = remixQuery(song)
    for (const site of ['youtube', 'soundcloud'] as const) {
      if (FAILING_REMIX_SEARCH.url === url && FAILING_REMIX_SEARCH.site === site) continue
      const { prefix, recorded } = sites[site]
      const searchUrl = `${prefix}${SEARCH_COUNTS[site]}:${query}`
      const search = JsonObject.parse(JSON.parse(readFixture(recorded)))
      const file = path.join(dir, `remixes-${index + 1}-${site}.search.json`)
      await writeFile(
        file,
        JSON.stringify({
          ...search,
          id: query,
          title: query,
          webpage_url: query,
          original_url: searchUrl,
          playlist_count: 0,
          entries: [],
        }),
      )
      rules.push({ url: searchUrl, stdout: file, note: `e2e: no remixes of ${url} on ${site}` })
    }
  }
  return rules
}

/**
 * The remix the e2e spec downloads: the Kryptonik remix in the mix track's recorded SoundCloud
 * search (one upload, its genre set on SoundCloud). A SoundCloud upload, so the spec spends none
 * of YouTube's pacing.
 */
const REMIX_DOWNLOAD = { search: 'soundcloud/search-remixes-never-gonna.json', id: '83083711' }
/** The recorded SoundCloud download its rule replays, and that source's probe. */
const SOUNDCLOUD_TEMPLATE = {
  download: 'soundcloud-hls-aac',
  probe: 'ffprobe/src-soundcloud-hls-aac-m4a.json',
}

const SearchEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  duration: z.number().positive(),
  uploader: z.string(),
  webpage_url: z.url(),
})

/**
 * REMIX_DOWNLOAD's download, files written to `dir`: the recorded SoundCloud download with the
 * upload's id, its DONE line with the upload's names, page and length (from the search), and the
 * source's probe at that length. Its lines come ROW_LINE_DELAY_MS apart, so the row shows progress.
 */
async function remixDownloadRule(dir: string): Promise<FakeDownloadRule> {
  const search = JsonObject.parse(JSON.parse(readFixture(REMIX_DOWNLOAD.search)))
  const entries = z.array(JsonObject).parse(search.entries)
  const entry = SearchEntrySchema.parse(entries.find((item) => item.id === REMIX_DOWNLOAD.id))
  const log = (stream: string) =>
    readFixture(`downloads/${SOUNDCLOUD_TEMPLATE.download}.${stream}.log`)
  const doneLine = log('stdout')
    .split('\n')
    .find((line) => line.startsWith('DONE '))
  const recordedId = z.object({ id: z.string() }).parse(JSON.parse(doneLine?.slice(5) ?? 'null')).id
  const stdout = log('stdout')
    .replaceAll(recordedId, entry.id)
    .split('\n')
    .map((line) => {
      if (!line.startsWith('DONE ')) return line
      const done = JsonObject.parse(JSON.parse(line.slice('DONE '.length)))
      const { title, duration, uploader, webpage_url } = entry
      return `DONE ${JSON.stringify({ ...done, title, track: title, duration, uploader, webpage_url })}`
    })
    .join('\n')
  const probe = JsonObject.parse(JSON.parse(readFixture(SOUNDCLOUD_TEMPLATE.probe)))
  const format = JsonObject.parse(probe.format)
  const prefix = path.join(dir, `remix-${entry.id}`)
  const probeFile = `${prefix}.probe.json`
  await writeFile(`${prefix}.stdout.log`, stdout)
  await writeFile(`${prefix}.stderr.log`, log('stderr').replaceAll(recordedId, entry.id))
  await writeFile(
    probeFile,
    JSON.stringify({ ...probe, format: { ...format, duration: entry.duration.toFixed(6) } }),
  )
  return {
    url: entry.webpage_url,
    download: prefix,
    probe: probeFile,
    lineDelayMs: ROW_LINE_DELAY_MS,
    note: `e2e: the recorded SoundCloud download as the remix ${entry.id}`,
  }
}

/**
 * How long a preview takes to prepare in e2e: the UI shows its "preparing" state for this long
 * before the player can play (the fake would answer at once).
 */
const PREVIEW_DELAY_MS = 700

/** The two uploads of the e2e remix list that don't play (the rest of its 24 uploads do). */
const PREVIEW_GO_PLUS_URL = 'https://soundcloud.com/timmohendriks/never-gonna-give-you-up-remix'
const PREVIEW_GEO_URL = 'https://www.youtube.com/watch?v=k5zzJ_yWT_k'

/**
 * Previews (ADR-029) of every upload in the mix track's recorded remix searches (the 20 remixes of
 * "Never Gonna Give You Up", 24 uploads): each prepares in PREVIEW_DELAY_MS and plays the fake's
 * AAC stream, except the Timmo Hendriks SoundCloud upload (a Go+ track: `preview_only`) and the
 * Krysiek remix's second YouTube upload (blocked in the country: `geo_blocked`).
 */
function previewRules(): FakeYtdlpRule[] {
  const rules: FakeYtdlpRule[] = []
  for (const [platform, file] of [
    ['youtube', 'youtube/search-remixes-never-gonna.json'],
    ['soundcloud', 'soundcloud/search-remixes-never-gonna.json'],
  ] as const) {
    for (const upload of parseSearchResults(platform, JSON.parse(readFixture(file)))) {
      const note = `e2e: the preview of the remix upload ${upload.id}`
      if (upload.url === PREVIEW_GO_PLUS_URL) {
        rules.push({ url: upload.url, exit: 101, note: `${note} (Go+: preview_only)` })
      } else if (upload.url === PREVIEW_GEO_URL) {
        rules.push({
          url: upload.url,
          stderr: 'errors/youtube-geo-blocked.log',
          exit: 1,
          delayMs: PREVIEW_DELAY_MS,
          note: `${note} (geo_blocked)`,
        })
      } else {
        rules.push({ url: upload.url, preview: 'm4a', delayMs: PREVIEW_DELAY_MS, note })
      }
    }
  }
  return rules
}

/** A fixture (relative to test/fixtures) or a file a rule wrote (absolute). */
const readFile = (file: string): string =>
  path.isAbsolute(file) ? readFileSync(file, 'utf8') : readFixture(file)

/**
 * The e2e rules, their files written to `dir`: the UI states no recording shows (the slow list, the
 * private track in a playlist, the hanging download), then downloads for the set row and for every
 * row of DOWNLOADABLE, then empty remix searches for the single tracks the specs paste and the
 * download of the remix the remix spec downloads, and the previews of the remix uploads.
 */
async function e2eRules(dir: string): Promise<FakeYtdlpRule[]> {
  await mkdir(dir)
  const rows = new Map(DOWNLOADABLE.flatMap(rowsOf).map((row) => [row.url, row]))
  const rules: FakeYtdlpRule[] = [
    SLOW_PLAYLIST,
    PRIVATE_IN_PLAYLIST,
    ...(await hangingRules(dir)),
    SET_ROW_BY_API_URL,
    ...(await emptyRemixRules(dir, [
      ...SINGLE_TRACKS,
      { url: HANGING_URL, info: path.join(dir, `${HANGING_ID}.info.json`) },
    ])),
    await remixDownloadRule(dir),
    ...previewRules(),
  ]
  for (const row of rows.values()) {
    rules.push(
      ...(await youtubeDownloadRules(dir, row, {
        lineDelayMs: ROW_LINE_DELAY_MS,
        note: `e2e: the recorded download as ${row.id}`,
      })),
    )
  }
  return rules
}

/**
 * How long the Spotify track's YouTube search takes in e2e: the UI shows the track's DRM note and
 * "Finding it on YouTube…" until the match comes, which the recorded search would answer at once.
 */
const SPOTIFY_SEARCH_DELAY_MS = 1500

/** The recorded search of the Spotify track (spotify/track.html), slowed down. */
const SPOTIFY_TRACK_SEARCH: FakeYtdlpRule = {
  url: 'ytsearch10:Rick Astley - Never Gonna Give You Up',
  stdout: 'youtube/search.json',
  delayMs: SPOTIFY_SEARCH_DELAY_MS,
  note: 'e2e: the recorded search, after a delay so the UI shows the matching state',
}

/** The uploader of the Spotify album's made-up matches, and the album's artist. */
const SPOTIFY_ALBUM_ARTIST = 'Rick Astley'

/**
 * Everything the Spotify album (spotify/album.html: "Whenever You Need Somebody" by Rick Astley,
 * 10 rows) needs to download on the fake engine, files written to `dir`:
 * - `pages`: a track page for rows 2-10 (the fixture server has row 1's, spotify/track.html),
 *   synthetic: track.html with the row's id, title and length;
 * - `rules`: for rows 2-10, the YouTube search the match step runs (synthetic: youtube/search.json
 *   with one made-up result, `Rick Astley - <title> (Official Audio)` on the artist's channel at
 *   the row's length) and that upload's download (the recorded one, as for the playlist rows).
 *   Row 1 (the Spotify track) gets only SPOTIFY_TRACK_SEARCH, its recorded search slowed down;
 *   its match, dQw4w9WgXcQ, is the mix's seed track, which downloads by DOWNLOADABLE.
 */
async function spotifyAlbumRules(
  dir: string,
): Promise<{ pages: Record<string, string>; rules: FakeYtdlpRule[] }> {
  const album = parseEmbedPage(readFixture('spotify/album.html'))
  const trackPage = readFixture('spotify/track.html')
  const recorded = parseEmbedPage(trackPage)
  if (album.type !== 'album' || recorded.type !== 'track') throw new Error('unexpected fixtures')
  const search = JsonObject.parse(JSON.parse(readFixture('youtube/search.json')))
  const pages: Record<string, string> = {}
  const rules: FakeYtdlpRule[] = [SPOTIFY_TRACK_SEARCH]
  for (const [index, row] of album.rows.entries()) {
    if (row.id === recorded.track.id) continue
    if (row.durationSec === undefined) throw new Error(`album row ${index + 1} has no length`)
    const page = trackPage
      .replaceAll(recorded.track.id, row.id)
      .replaceAll(recorded.track.title, row.title)
      .replace(/"duration": \d+/, `"duration": ${Math.round(row.durationSec * 1000)}`)
    const read = parseEmbedPage(page)
    if (read.type !== 'track' || read.track.title !== row.title || read.track.id !== row.id) {
      throw new Error(`the synthetic page of album row ${index + 1} doesn't read as that row`)
    }
    pages[`/embed/track/${row.id}`] = page

    const id = `e2eSpAlb${String(index + 1).padStart(3, '0')}`
    const url = `https://www.youtube.com/watch?v=${id}`
    const title = `${SPOTIFY_ALBUM_ARTIST} - ${row.title} (Official Audio)`
    const duration = Math.round(row.durationSec)
    const query = searchQuery(read.track)
    const searchUrl = `ytsearch${SEARCH_RESULTS}:${query}`
    const file = path.join(dir, `${id}.search.json`)
    const result = { _type: 'url', ie_key: 'Youtube', id, url, title, duration }
    const uploader = { channel: SPOTIFY_ALBUM_ARTIST, uploader: SPOTIFY_ALBUM_ARTIST }
    await writeFile(
      file,
      JSON.stringify({
        ...search,
        id: query,
        title: query,
        webpage_url: query,
        original_url: searchUrl,
        playlist_count: 1,
        entries: [{ ...result, ...uploader, live_status: null }],
      }),
    )
    rules.push({
      url: searchUrl,
      stdout: file,
      note: `e2e: Spotify album row ${index + 1}'s search`,
    })
    rules.push(
      ...(await youtubeDownloadRules(
        dir,
        { id, url, title, duration, ...uploader },
        { lineDelayMs: ROW_LINE_DELAY_MS, note: `e2e: Spotify album row ${index + 1}'s match` },
      )),
    )
  }
  return { pages, rules }
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
const rulesDir = path.join(tempDir, 'downloads')
const ownRules = await e2eRules(rulesDir)
const spotifyAlbum = await spotifyAlbumRules(rulesDir)
await writeFakeEngine(bin, {
  ytdlpRules: [...ownRules, ...spotifyAlbum.rules],
  ytdlpEnv: { FAKE_YTDLP_VERSION: todaysYtdlpVersion() },
})
// Spotify on 127.0.0.1; it stops with this process.
const spotify = await startSpotifyFixtures({ pages: spotifyAlbum.pages })
// The fakes are Node scripts, and PATH is this dir alone.
await symlink(process.execPath, path.join(bin, 'node'))
const dirs = await serverEnv(tempDir)
console.log(`[e2e-server] Fake engine in ${bin}, UI from ${webDist}, Spotify at ${spotify.origin}`)

server = spawn(process.execPath, ['src/index.ts'], {
  cwd: SERVER_DIR,
  env: {
    PATH: bin,
    PORT: String(port.data),
    DJS_WEB_DIST: webDist,
    DJS_SPOTIFY_ORIGIN: spotify.origin,
    ...dirs,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
server.once('error', (error) => fail(`Cannot start the server: ${error.message}`))
server.once('exit', (code, signal) => process.exit(exitCodeFor(code, signal)))
