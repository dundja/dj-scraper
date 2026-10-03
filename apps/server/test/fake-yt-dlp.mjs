#!/usr/bin/env node
// A fake yt-dlp for integration and e2e tests. It replays recorded fixtures and never touches the
// network.
//
// Tests symlink it as <tmpdir>/yt-dlp and point YTDLP_PATH at the link (see writeFakeYtdlp and
// writeFakeEngine in helpers.ts). Fixture paths are resolved from this file's real location: Node
// follows the main module's symlink, so import.meta.dirname is apps/server/test. Why one checked-in
// script behind symlinks: endpoint security scans every newly written executable on its first run,
// which made per-test scripts time out (see fake-tool.sh). Keep the exec bit (git mode 100755).
//
// What it does, in this order (after logging the call, see FAKE_YTDLP_CALLS):
// - `--version` prints FAKE_YTDLP_VERSION, or today's UTC date as a stable version (YYYY.MM.DD).
// - Argv sanity like a strict yt-dlp: `--ignore-config` and `--no-update` are required, and so is
//   exactly one argument after `--`. Otherwise it exits 2 with `fake-yt-dlp: …` on stderr. Exit 2
//   also means the test setup is wrong (bad manifest, missing fixture, a JSON fixture asked for
//   without -J), so it fails loudly instead of answering something plausible.
// - A call without -J that has -P and an `after_move:DONE` --print is a DOWNLOAD (see below). It
//   must carry the design's download argv (§4): --no-playlist as the effective playlist flag, -f,
//   an absolute -P, `-o %(id)s.%(ext)s`, --newline, --progress, both --progress-template values,
//   the START and DONE --print templates verbatim, and --abort-on-unavailable-fragments; else exit 2.
// - The URL after `--` picks the first matching rule, from FAKE_YTDLP_MANIFEST's rules and then
//   from fixtures/fake-yt-dlp.json. A rule is { url, playlist?, args?, stdout?, stderr?, exit?,
//   delayMs?, hang?, note? }, or a download rule { url, playlist?, args?, download, probe?, exit?,
//   lineDelayMs?, hangAfter?, delayMs?, hang?, note? }:
//     url      matches the argument after `--` exactly (the server passes `new URL(…).href`)
//     playlist 'yes' | 'no': the effective --yes-playlist/--no-playlist (the last one wins;
//              neither means 'yes', yt-dlp's default)
//     args     argv groups that must all appear before `--`; a group is one token or an array of
//              tokens that must appear in a row, e.g. [["-I", "1:3"], "--ignore-no-formats-error"]
//     stdout   fixture path (relative to test/fixtures, or absolute). A .json file is an info
//              document: it is served only to -J, compacted to one ASCII line like yt-dlp's
//              json.dumps, and a playlist only with --flat-playlist (the fixtures were recorded
//              flat). Any other file is printed verbatim.
//     stderr   fixture path, printed verbatim. exit: the exit code (default 0).
//     delayMs / hang: like the env knobs below, for this rule only.
//   A download call only matches download rules and extraction errors (a rule without stdout and
//   with a non-zero exit: yt-dlp fails the same way before it downloads). Other calls never match
//   download rules, so a URL can have a -J rule and a download rule.
// - -I (or --playlist-items) "N", "A:B", "A:" or ":B", comma-separated, keeps the playlist entries
//   whose playlist index is in range (indices come from the fixture's requested_entries when it has
//   them, so a recorded window keeps its real indices). It applies at every level, like yt-dlp.
//   playlist_count and the other fields stay as recorded; requested_entries lists the kept indices
//   whenever rows were cut.
// - No rule: `ERROR: Unsupported URL: <url>` on stderr, exit 1.
//
// Downloads replay fixtures/downloads/<download>.stdout.log and .stderr.log (`download` may also be
// an absolute path prefix for a test's own pair):
// - `{JOBDIR}` becomes the -P dir (JSON-escaped in START/DL/DONE lines), `{NOW+<n>}` the current
//   epoch second + n.
// - Order: stdout up to the last DL `finished` line before DONE, then every stderr line (PP lines,
//   errors), then the rest of stdout (DONE). Without a `finished` line, stderr follows all of stdout
//   before DONE. Each stream keeps its recorded order, so the bytes of each stream are the fixture's.
//   (soundcloud-list interleaves its PP lines between the STARTs live; the replay doesn't.)
// - Files, all inside the -P dir (exit 2 otherwise): with --write-thumbnail, DONE's
//   `thumbnails.-1.filepath` is written before the first line (as yt-dlp does), a small fake image
//   with its extension's magic bytes; without it, that key is left out of DONE. A DL `downloading`
//   line writes its `tmpfilename` (`FAKEPART …`) and, for fragments, `<filename>.ytdl`; a DL
//   `finished` line replaces them with `filename` as a FAKEAUDIO file (fake-media.mjs); before DONE
//   its `filepath` exists. The audio claims to be the rule's `probe` (an ffprobe JSON in fixtures/),
//   by default the recorded source matching DONE/START's ext and acodec (webm+opus, m4a+mp4a, mp3).
// - A START whose `available_at` is in the future waits, silently, `available_at - int(now)` seconds
//   before the next line, as yt-dlp does; FAKE_YTDLP_WAIT_MS replaces that length.
// - lineDelayMs sleeps before every line after the first. hangAfter N writes N lines, then hangs until
//   SIGINT (leaving the job dir as it is then, e.g. a .part file); the cancel cases' recorded stderr
//   tail is exactly the SIGINT answer below.
// - exit: the rule's, else that of the recorded manifest's rule for the same case, else 0 (the logs
//   don't carry it).
//
// Knobs, from the environment or from a JSON object of the same names in `.<link name>.fake.json`
// beside the link (which wins). The file lets in-process tests, whose run() calls inherit the test
// worker's environment, configure one link:
//   FAKE_YTDLP_VERSION   the --version output
//   FAKE_YTDLP_MANIFEST  an extra manifest ({ "rules": [...] }) whose rules are tried first
//   FAKE_YTDLP_DELAY_MS  sleep this long before answering
//   FAKE_YTDLP_HANG=1    never answer until signalled
//   FAKE_YTDLP_WAIT_MS   how long a download's forced wait (START available_at) lasts instead
//   FAKE_YTDLP_CALLS     append one JSON line per invocation: { argv, url, time, pid }
// Delay and hang never apply to --version, so the server's engine health probe stays fast.
// SIGINT at any point prints `\nERROR: Interrupted by user` to stderr and exits 1, as yt-dlp does
// (fixtures/errors/interrupted.log).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  audioBytes,
  FIXTURES,
  fixturePath,
  IMAGE_EXTENSIONS,
  imageBytes,
  isObject,
  readJson,
  sourceHeader,
  UsageError,
} from './fake-media.mjs'

process.on('SIGINT', () => {
  process.stderr.write('\nERROR: Interrupted by user\n', () => process.exit(1))
})

const MANIFEST = path.join(FIXTURES, 'fake-yt-dlp.json')
const DOWNLOADS = path.join(FIXTURES, 'downloads')
const KNOBS = [
  'FAKE_YTDLP_VERSION',
  'FAKE_YTDLP_MANIFEST',
  'FAKE_YTDLP_DELAY_MS',
  'FAKE_YTDLP_HANG',
  'FAKE_YTDLP_WAIT_MS',
  'FAKE_YTDLP_CALLS',
]
const RULE_KEYS = new Set([
  'url',
  'playlist',
  'args',
  'stdout',
  'stderr',
  'exit',
  'delayMs',
  'hang',
  'note',
  'download',
  'probe',
  'lineDelayMs',
  'hangAfter',
])
const DOWNLOAD_ONLY_KEYS = ['probe', 'lineDelayMs', 'hangAfter']

/** The design's download argv (§4) that the recorded download cases depend on. */
const START_PRINT =
  'before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j'
const DONE_PRINT =
  'after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j'
const DOWNLOAD_ARGV = [
  ['--abort-on-unavailable-fragments'],
  ['-o', '%(id)s.%(ext)s'],
  ['--newline'],
  ['--progress'],
  ['--progress-template', 'download:DL %(progress)j'],
  ['--progress-template', 'postprocess:PP %(progress.postprocessor)s %(progress.status)s'],
  ['--print', START_PRINT],
  ['--print', DONE_PRINT],
]

/** The recorded source a downloaded file is, by its extension and yt-dlp's acodec. */
const DEFAULT_PROBES = [
  { ext: 'webm', acodec: /^opus$/, probe: 'ffprobe/src-youtube-251-webm.json' },
  { ext: 'm4a', acodec: /^mp4a/, probe: 'ffprobe/src-youtube-140-m4a.json' },
  { ext: 'mp3', acodec: /^mp3$/, probe: 'ffprobe/src-soundcloud-mp3.json' },
]

const isDelay = (value) => Number.isSafeInteger(value) && value >= 0

function usage(message) {
  throw new UsageError(message)
}

/** Env knobs, overridden by the link's own `.<name>.fake.json`. */
function readKnobs(link) {
  const knobs = {}
  for (const name of KNOBS) {
    const value = process.env[name]
    if (value !== undefined && value !== '') knobs[name] = value
  }
  if (link === undefined) return knobs
  const file = path.join(path.dirname(link), `.${path.basename(link)}.fake.json`)
  if (!existsSync(file)) return knobs
  const extra = readJson(file)
  if (!isObject(extra)) usage(`${file}: expected a JSON object of FAKE_YTDLP_* strings`)
  for (const [name, value] of Object.entries(extra)) {
    if (!KNOBS.includes(name) || typeof value !== 'string') {
      usage(`${file}: unknown knob or non-string value: ${name}`)
    }
    knobs[name] = value
  }
  return knobs
}

function loadRules(file) {
  const manifest = readJson(file)
  if (!isObject(manifest) || !Array.isArray(manifest.rules)) {
    usage(`${file}: expected { "rules": [...] }`)
  }
  return manifest.rules.map((rule, i) => checkRule(rule, `${file} rule ${i + 1}`))
}

function checkRule(rule, where) {
  if (!isObject(rule)) usage(`${where}: not an object`)
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key))
  if (unknown.length > 0) usage(`${where}: unknown keys ${unknown.join(', ')}`)
  const groups = rule.args ?? []
  const isGroup = (group) =>
    typeof group === 'string' ||
    (Array.isArray(group) && group.length > 0 && group.every((t) => typeof t === 'string'))
  const isDownload = rule.download !== undefined
  if (
    typeof rule.url !== 'string' ||
    (rule.playlist !== undefined && rule.playlist !== 'yes' && rule.playlist !== 'no') ||
    !Array.isArray(groups) ||
    !groups.every(isGroup) ||
    (rule.stdout !== undefined && (typeof rule.stdout !== 'string' || isDownload)) ||
    (rule.stderr !== undefined && (typeof rule.stderr !== 'string' || isDownload)) ||
    (rule.exit !== undefined &&
      !(Number.isInteger(rule.exit) && rule.exit >= 0 && rule.exit < 256)) ||
    (rule.delayMs !== undefined && !isDelay(rule.delayMs)) ||
    (rule.hang !== undefined && typeof rule.hang !== 'boolean') ||
    (rule.note !== undefined && typeof rule.note !== 'string') ||
    (isDownload &&
      (typeof rule.download !== 'string' ||
        !(/^[a-z0-9][a-z0-9-]*$/.test(rule.download) || path.isAbsolute(rule.download)))) ||
    (rule.probe !== undefined && typeof rule.probe !== 'string') ||
    (rule.lineDelayMs !== undefined && !isDelay(rule.lineDelayMs)) ||
    (rule.hangAfter !== undefined && !isDelay(rule.hangAfter)) ||
    (!isDownload && DOWNLOAD_ONLY_KEYS.some((key) => rule[key] !== undefined))
  ) {
    usage(`${where}: invalid rule ${JSON.stringify(rule)}`)
  }
  return { ...rule, args: groups.map((group) => (typeof group === 'string' ? [group] : group)) }
}

/** Whether `tokens` appear in a row in `options`. */
function hasRun(options, tokens) {
  for (let i = 0; i + tokens.length <= options.length; i++) {
    if (tokens.every((token, j) => options[i + j] === token)) return true
  }
  return false
}

function lastIndexOfAny(options, names) {
  let found = -1
  options.forEach((option, i) => {
    if (names.includes(option)) found = i
  })
  return found
}

/** The value after the last `name` in `options`. */
function optionValue(options, name) {
  const at = options.lastIndexOf(name)
  return at === -1 ? undefined : options[at + 1]
}

/** -I's `N`, `A:B`, `A:` and `:B` parts as inclusive [start, end] ranges. */
function parseItems(spec) {
  return spec.split(',').map((part) => {
    const match = /^(\d+)$|^(\d*):(\d*)$/.exec(part)
    if (match === null) usage(`unsupported -I ${JSON.stringify(spec)} (use N, A:B, A: or :B)`)
    const [, single, from, to] = match
    const start = Number(single ?? (from || 1))
    const end = single !== undefined ? start : to ? Number(to) : Number.POSITIVE_INFINITY
    if (start < 1 || end < start) usage(`unsupported -I ${JSON.stringify(spec)}`)
    return [start, end]
  })
}

/** Keeps the entries whose playlist index is in `ranges`, in nested playlists too. */
function selectEntries(info, ranges) {
  if (!isObject(info) || info._type !== 'playlist' || !Array.isArray(info.entries)) return info
  const recorded = info.requested_entries
  const indexAt = (i) =>
    Array.isArray(recorded) && recorded.length === info.entries.length ? recorded[i] : i + 1
  const entries = []
  const indices = []
  info.entries.forEach((entry, i) => {
    const index = indexAt(i)
    if (!ranges.some(([start, end]) => index >= start && index <= end)) return
    entries.push(selectEntries(entry, ranges))
    indices.push(index)
  })
  if (entries.length === info.entries.length) return { ...info, entries }
  return { ...info, entries, requested_entries: indices }
}

/** Python's json.dumps with ensure_ascii, which yt-dlp -J uses: everything past `~` is escaped. */
const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

function readFixture(file) {
  try {
    return readFileSync(fixturePath(file))
  } catch (error) {
    usage(`cannot read fixture ${file}: ${error.code ?? error.message}`)
  }
}

/** The rule's stdout for this call: an info document as yt-dlp prints it, or a file verbatim. */
function renderStdout(rule, options) {
  if (rule.stdout === undefined) return ''
  const bytes = readFixture(rule.stdout)
  if (!rule.stdout.endsWith('.json')) return bytes
  if (!options.includes('-J') && !options.includes('--dump-single-json')) {
    usage(
      `${rule.stdout} is a -J document, but this call has no -J (a download needs -P and the DONE --print)`,
    )
  }
  let info
  try {
    info = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    usage(`${rule.stdout} is not JSON: ${error.message}`)
  }
  if (isObject(info) && info._type === 'playlist' && !options.includes('--flat-playlist')) {
    usage(
      `${rule.stdout} was recorded with --flat-playlist; without it yt-dlp extracts every entry`,
    )
  }
  const items = lastIndexOfAny(options, ['-I', '--playlist-items'])
  if (items !== -1) {
    const spec = options[items + 1]
    if (spec === undefined) usage('-I needs a value')
    info = selectEntries(info, parseItems(spec))
  }
  return `${asciiJson(info)}\n`
}

/** A download: no -J, and both a -P dir and the DONE print, which only a download prints. */
function isDownloadCall(options) {
  if (options.includes('-J') || options.includes('--dump-single-json')) return false
  const done = options.some(
    (option, i) => options[i - 1] === '--print' && option.startsWith('after_move:DONE'),
  )
  return done && options.includes('-P')
}

/** Checks the §4 argv the download fixtures were recorded with; returns the job dir. */
function checkDownloadArgv(options, playlist) {
  if (playlist !== 'no') usage('a download needs --no-playlist: one job downloads one track')
  for (const tokens of DOWNLOAD_ARGV) {
    if (!hasRun(options, tokens)) usage(`a download needs ${tokens.join(' ')} (design §4)`)
  }
  if (optionValue(options, '-f') === undefined) usage('a download needs -f <selector>')
  const jobDir = optionValue(options, '-P')
  if (jobDir === undefined || !path.isAbsolute(jobDir)) usage('-P needs an absolute job dir')
  return path.resolve(jobDir)
}

/** Lines of a log, each with whether it ended in `\n` (a log's last line may not). */
function splitLines(text, stream) {
  if (text === '') return []
  const lines = text.split('\n')
  const terminated = lines.at(-1) === ''
  if (terminated) lines.pop()
  return lines.map((line, i) => ({
    stream,
    text: line,
    newline: terminated || i < lines.length - 1,
  }))
}

const JSON_LINE = /^(START|DL|DONE) /
const THUMBNAIL_PATH = /, "thumbnails\.-1\.filepath": "(?:[^"\\]|\\.)*"/

function parseLine(text) {
  const match = JSON_LINE.exec(text)
  if (match === null) return undefined
  try {
    const info = JSON.parse(text.slice(match[0].length))
    return isObject(info) ? { kind: match[1], info } : undefined
  } catch {
    usage(`a ${match[1]} line of the case is not JSON after the placeholders: ${text}`)
  }
}

function readCase(name) {
  const prefix = path.isAbsolute(name) ? name : path.join(DOWNLOADS, name)
  const read = (ext) => readFixture(`${prefix}.${ext}.log`).toString('utf8')
  return { stdout: read('stdout'), stderr: read('stderr') }
}

/** The recorded case's lines in replay order, placeholders filled (see the header comment). */
function replayLines(rule, jobDir, thumbnail) {
  const { stdout, stderr } = readCase(rule.download)
  const nowSec = Math.floor(Date.now() / 1000)
  const escapedDir = asciiJson(jobDir).slice(1, -1)
  const fill = (line) => {
    let text = line.text
      .replaceAll('{JOBDIR}', JSON_LINE.test(line.text) ? escapedDir : jobDir)
      .replace(/\{NOW\+(\d+)\}/g, (_, n) => String(nowSec + Number(n)))
    if (!thumbnail && text.startsWith('DONE ')) text = text.replace(THUMBNAIL_PATH, '')
    return { ...line, text, parsed: parseLine(text) }
  }
  const out = splitLines(stdout, 'stdout').map(fill)
  const err = splitLines(stderr, 'stderr').map(fill)
  const doneAt = out.findIndex((line) => line.parsed?.kind === 'DONE')
  const before = doneAt === -1 ? out : out.slice(0, doneAt)
  const after = doneAt === -1 ? [] : out.slice(doneAt)
  const finished = before.findLastIndex(
    (line) => line.parsed?.kind === 'DL' && line.parsed.info.status === 'finished',
  )
  const split = finished === -1 ? before.length : finished + 1
  return [...before.slice(0, split), ...err, ...before.slice(split), ...after]
}

/** Writes and deletes the files a download's lines name, all inside the job dir. */
function createJobFiles(rule, jobDir, lines) {
  const inside = (file) => {
    if (typeof file !== 'string') return undefined
    const relative = path.relative(jobDir, path.resolve(jobDir, file))
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      usage(`the case names a file outside the job dir: ${file}`)
    }
    return path.resolve(jobDir, file)
  }
  const done = lines.find((line) => line.parsed?.kind === 'DONE')?.parsed.info
  const start = lines.find((line) => line.parsed?.kind === 'START')?.parsed.info

  const writeAudio = (file) => {
    const ext = path.extname(file).slice(1)
    const acodec = String(done?.acodec ?? start?.acodec ?? '')
    const probe =
      rule.probe ??
      DEFAULT_PROBES.find((source) => source.ext === ext && source.acodec.test(acodec))?.probe
    if (probe === undefined) {
      usage(`no default probe for a .${ext} ${acodec} download: give the rule a probe`)
    }
    const payload = Buffer.from(`fake ${acodec} stream of ${path.basename(file)}\n`)
    writeFileSync(file, audioBytes(sourceHeader(probe), payload))
  }

  return {
    /** Before the first line: yt-dlp writes the thumbnail before START. */
    begin() {
      mkdirSync(jobDir, { recursive: true })
      const thumbnail = inside(done?.['thumbnails.-1.filepath'])
      if (thumbnail === undefined) return
      const format = IMAGE_EXTENSIONS[path.extname(thumbnail).slice(1).toLowerCase()]
      if (format === undefined) usage(`no fake image for the thumbnail ${thumbnail}`)
      const size = { jpeg: [1500, 1500], png: [100, 100], webp: [480, 360] }[format]
      writeFileSync(thumbnail, imageBytes({ format, width: size[0], height: size[1] }))
    },
    /** Before `line` is printed. */
    before(line) {
      const { kind, info } = line.parsed ?? {}
      if (kind === 'DL' && info.status === 'downloading') {
        const part = inside(info.tmpfilename)
        if (part !== undefined) {
          writeFileSync(part, `FAKEPART ${info.downloaded_bytes ?? 0} bytes\n`)
        }
        const target = inside(info.filename)
        if (target !== undefined && info.fragment_index !== undefined) {
          writeFileSync(`${target}.ytdl`, '{"downloader": {"current_fragment": {}}}\n')
        }
      } else if (kind === 'DL' && info.status === 'finished') {
        const target = inside(info.filename)
        if (target === undefined) usage('a finished DL line without a filename')
        rmSync(`${target}.part`, { force: true })
        rmSync(`${target}.ytdl`, { force: true })
        writeAudio(target)
      } else if (kind === 'DONE') {
        const file = inside(info.filepath)
        if (file === undefined) usage('a DONE line without a filepath')
        if (!existsSync(file)) writeAudio(file)
      }
    },
  }
}

/** Resolves once the text is handed to the pipe, so lines leave in replay order. */
const write = (stream, text) =>
  new Promise((resolve) => {
    const out = stream === 'stdout' ? process.stdout : process.stderr
    out.write(text, resolve)
  })

/** Kept alive until a signal; the SIGINT handler answers like yt-dlp. */
const hangForever = () =>
  new Promise(() => {
    setInterval(() => {}, 60_000)
  })

async function replayDownload(rule, { jobDir, thumbnail, waitMs, recordedRules }) {
  const lines = replayLines(rule, jobDir, thumbnail)
  if (rule.hangAfter !== undefined && rule.hangAfter > lines.length) {
    usage(`hangAfter ${rule.hangAfter}, but the case has ${lines.length} lines`)
  }
  const files = createJobFiles(rule, jobDir, lines)
  files.begin()
  for (const [i, line] of lines.entries()) {
    if (rule.hangAfter === i) await hangForever()
    if (i > 0 && rule.lineDelayMs) await sleep(rule.lineDelayMs)
    files.before(line)
    await write(line.stream, line.newline ? `${line.text}\n` : line.text)
    const availableAt = line.parsed?.kind === 'START' ? line.parsed.info.available_at : undefined
    if (typeof availableAt === 'number') {
      const seconds = availableAt - Math.floor(Date.now() / 1000)
      if (seconds > 0) await sleep(waitMs ?? seconds * 1000)
    }
  }
  if (rule.hangAfter === lines.length) await hangForever()
  const recorded = recordedRules.find((candidate) => candidate.download === rule.download)
  process.exitCode = rule.exit ?? recorded?.exit ?? 0
}

async function main() {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  const options = separator === -1 ? argv : argv.slice(0, separator)
  const positional = separator === -1 ? [] : argv.slice(separator + 1)
  const url = positional.length === 1 ? positional[0] : null

  const knobs = readKnobs(process.argv[1])
  if (knobs.FAKE_YTDLP_CALLS !== undefined) {
    const record = { argv, url, time: Date.now(), pid: process.pid }
    appendFileSync(knobs.FAKE_YTDLP_CALLS, `${JSON.stringify(record)}\n`)
  }

  if (options.includes('--version')) {
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.')
    process.stdout.write(`${knobs.FAKE_YTDLP_VERSION ?? today}\n`)
    return
  }

  for (const flag of ['--ignore-config', '--no-update']) {
    if (!options.includes(flag)) usage(`${flag} is missing: user config or a self-update could run`)
  }
  if (separator === -1) usage("no '--' before the URL, so a URL could be read as an option")
  if (url === null) usage(`expected exactly one argument after '--', got ${positional.length}`)

  const delayMs = knobs.FAKE_YTDLP_DELAY_MS === undefined ? 0 : Number(knobs.FAKE_YTDLP_DELAY_MS)
  if (!isDelay(delayMs)) usage(`FAKE_YTDLP_DELAY_MS must be a whole number of ms`)
  const hang = knobs.FAKE_YTDLP_HANG ?? '0'
  if (hang !== '0' && hang !== '1') usage('FAKE_YTDLP_HANG must be 1 or 0')
  const waitMs =
    knobs.FAKE_YTDLP_WAIT_MS === undefined ? undefined : Number(knobs.FAKE_YTDLP_WAIT_MS)
  if (waitMs !== undefined && !isDelay(waitMs)) {
    usage('FAKE_YTDLP_WAIT_MS must be a whole number of ms')
  }

  const last = lastIndexOfAny(options, ['--yes-playlist', '--no-playlist'])
  const playlist = last !== -1 && options[last] === '--no-playlist' ? 'no' : 'yes'
  const download = isDownloadCall(options)
  const jobDir = download ? checkDownloadArgv(options, playlist) : undefined

  const extra = knobs.FAKE_YTDLP_MANIFEST
  const recordedRules = loadRules(MANIFEST)
  const rules = [...(extra === undefined ? [] : loadRules(extra)), ...recordedRules]
  const serves = (candidate) =>
    download
      ? candidate.download !== undefined ||
        (candidate.stdout === undefined && (candidate.exit ?? 0) !== 0)
      : candidate.download === undefined
  const rule = rules.find(
    (candidate) =>
      candidate.url === url &&
      serves(candidate) &&
      (candidate.playlist === undefined || candidate.playlist === playlist) &&
      candidate.args.every((tokens) => hasRun(options, tokens)),
  )

  const answer =
    rule === undefined
      ? { stdout: '', stderr: `ERROR: Unsupported URL: ${url}\n`, exit: 1 }
      : rule.download !== undefined
        ? undefined
        : {
            stdout: renderStdout(rule, options),
            stderr: rule.stderr === undefined ? '' : readFixture(rule.stderr),
            exit: rule.exit ?? 0,
          }

  const wait = delayMs + (rule?.delayMs ?? 0)
  if (wait > 0) await sleep(wait)
  if (hang === '1' || rule?.hang === true) {
    await hangForever()
  }
  if (answer === undefined) {
    const thumbnail = options.includes('--write-thumbnail')
    await replayDownload(rule, { jobDir, thumbnail, waitMs, recordedRules })
    return
  }
  process.stderr.write(answer.stderr)
  process.stdout.write(answer.stdout)
  // No process.exit(): on macOS, writes to a pipe are asynchronous and would be cut off.
  process.exitCode = answer.exit
}

try {
  await main()
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  process.stderr.write(`fake-yt-dlp: ${error.message}\n`)
  process.exitCode = 2
}
