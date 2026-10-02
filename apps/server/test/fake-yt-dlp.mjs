#!/usr/bin/env node
// A fake yt-dlp for integration and e2e tests. It replays recorded fixtures and never touches the
// network.
//
// Tests symlink it as <tmpdir>/yt-dlp and point YTDLP_PATH at the link (see writeFakeYtdlp in
// helpers.ts). Fixture paths are resolved from this file's real location: Node follows the main
// module's symlink, so import.meta.dirname is apps/server/test. Why one checked-in script behind
// symlinks: endpoint security scans every newly written executable on its first run, which made
// per-test scripts time out (see fake-tool.sh). Keep the exec bit (git mode 100755).
//
// What it does, in this order (after logging the call, see FAKE_YTDLP_CALLS):
// - `--version` prints FAKE_YTDLP_VERSION, or today's UTC date as a stable version (YYYY.MM.DD).
// - Argv sanity like a strict yt-dlp: `--ignore-config` and `--no-update` are required, and so is
//   exactly one argument after `--`. Otherwise it exits 2 with `fake-yt-dlp: …` on stderr. Exit 2
//   also means the test setup is wrong (bad manifest, missing fixture, a JSON fixture asked for
//   without -J), so it fails loudly instead of answering something plausible.
// - The URL after `--` picks the first matching rule, from FAKE_YTDLP_MANIFEST's rules and then
//   from fixtures/fake-yt-dlp.json. A rule is { url, playlist?, args?, stdout?, stderr?, exit?,
//   delayMs?, hang?, note? }:
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
// - -I (or --playlist-items) "N", "A:B", "A:" or ":B", comma-separated, keeps the playlist entries
//   whose playlist index is in range (indices come from the fixture's requested_entries when it has
//   them, so a recorded window keeps its real indices). It applies at every level, like yt-dlp.
//   playlist_count and the other fields stay as recorded; requested_entries lists the kept indices
//   whenever rows were cut.
// - No rule: `ERROR: Unsupported URL: <url>` on stderr, exit 1.
//
// Knobs, from the environment or from a JSON object of the same names in `.<link name>.fake.json`
// beside the link (which wins). The file lets in-process tests, whose run() calls inherit the test
// worker's environment, configure one link:
//   FAKE_YTDLP_VERSION   the --version output
//   FAKE_YTDLP_MANIFEST  an extra manifest ({ "rules": [...] }) whose rules are tried first
//   FAKE_YTDLP_DELAY_MS  sleep this long before answering
//   FAKE_YTDLP_HANG=1    never answer until signalled
//   FAKE_YTDLP_CALLS     append one JSON line per invocation: { argv, url, time, pid }
// Delay and hang never apply to --version, so the server's engine health probe stays fast.
// SIGINT at any point prints `\nERROR: Interrupted by user` to stderr and exits 1, as yt-dlp does
// (fixtures/errors/interrupted.log).

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.on('SIGINT', () => {
  process.stderr.write('\nERROR: Interrupted by user\n', () => process.exit(1))
})

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const MANIFEST = path.join(FIXTURES, 'fake-yt-dlp.json')
const KNOBS = [
  'FAKE_YTDLP_VERSION',
  'FAKE_YTDLP_MANIFEST',
  'FAKE_YTDLP_DELAY_MS',
  'FAKE_YTDLP_HANG',
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
])

/** A broken call or test setup: exit 2, like yt-dlp's own usage errors. */
class UsageError extends Error {}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
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

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    usage(`cannot read ${file}: ${error.code ?? error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    usage(`${file} is not JSON: ${error.message}`)
  }
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
  if (
    typeof rule.url !== 'string' ||
    (rule.playlist !== undefined && rule.playlist !== 'yes' && rule.playlist !== 'no') ||
    !Array.isArray(groups) ||
    !groups.every(isGroup) ||
    (rule.stdout !== undefined && typeof rule.stdout !== 'string') ||
    (rule.stderr !== undefined && typeof rule.stderr !== 'string') ||
    (rule.exit !== undefined &&
      !(Number.isInteger(rule.exit) && rule.exit >= 0 && rule.exit < 256)) ||
    (rule.delayMs !== undefined && !isDelay(rule.delayMs)) ||
    (rule.hang !== undefined && typeof rule.hang !== 'boolean') ||
    (rule.note !== undefined && typeof rule.note !== 'string')
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

const fixturePath = (file) => (path.isAbsolute(file) ? file : path.join(FIXTURES, file))

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
    usage(`${rule.stdout} is a -J document, but this call has no -J (downloads aren't faked)`)
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

  const extra = knobs.FAKE_YTDLP_MANIFEST
  const rules = [...(extra === undefined ? [] : loadRules(extra)), ...loadRules(MANIFEST)]
  const last = lastIndexOfAny(options, ['--yes-playlist', '--no-playlist'])
  const playlist = last !== -1 && options[last] === '--no-playlist' ? 'no' : 'yes'
  const rule = rules.find(
    (candidate) =>
      candidate.url === url &&
      (candidate.playlist === undefined || candidate.playlist === playlist) &&
      candidate.args.every((tokens) => hasRun(options, tokens)),
  )

  const answer =
    rule === undefined
      ? { stdout: '', stderr: `ERROR: Unsupported URL: ${url}\n`, exit: 1 }
      : {
          stdout: renderStdout(rule, options),
          stderr: rule.stderr === undefined ? '' : readFixture(rule.stderr),
          exit: rule.exit ?? 0,
        }

  const wait = delayMs + (rule?.delayMs ?? 0)
  if (wait > 0) await sleep(wait)
  if (hang === '1' || rule?.hang === true) {
    // Kept alive until a signal; the SIGINT handler answers like yt-dlp.
    setInterval(() => {}, 60_000)
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
