// The server that apps/web's Playwright config runs as its webServer:
//
//   PORT=4849 node <repo>/apps/server/test/e2e-server.ts      (from any cwd)
//
// - Runs the real entry (src/index.ts) in production mode, without --dev or --open, serving the
//   built UI from apps/web/dist, or from DJS_WEB_DIST if set (absolute). Exits 1 if there is none.
// - The engine is a healthy fake: a temp dir holding fake yt-dlp (today's version), ffmpeg and
//   ffprobe (the 8.0 brew fixtures) is the server's whole PATH, so GET /api/health is ok, with node
//   as the JS runtime. Nothing real is found and nothing touches the network.
// - Its data dir (DJS_DATA_DIR) and home folder (HOME) are in the same temp dir, so it never touches
//   the user's ~/Library/Application Support/DJ Scraper or ~/Music.
// - SIGINT, SIGTERM and SIGHUP are passed on to the server. When it exits, the temp dir is removed
//   and this script exits with the server's code.
//
// The server is spawned here directly, not through run(): run() puts it in its own process group,
// so a signal or SIGKILL to this script's group (Ctrl-C, Playwright's teardown) would miss it and
// leave the port taken. In this group it gets those signals as well.
import { type ChildProcess, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { PortSchema } from '@dj-scraper/shared'
import { DEFAULT_WEB_DIST } from '../src/config.ts'
import { PROBE_ARGV } from '../src/engine/binaries.ts'
import { hasBuiltUi } from '../src/routes/web.ts'
import {
  engineFixture,
  makeTempDir,
  SERVER_DIR,
  serverEnv,
  todaysYtdlpVersion,
  writeFakeTool,
} from './helpers.ts'

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
await writeFakeTool(bin, 'yt-dlp', { argv: PROBE_ARGV.ytdlp, stdout: `${todaysYtdlpVersion()}\n` })
await writeFakeTool(bin, 'ffmpeg', {
  argv: PROBE_ARGV.ffmpeg,
  stdout: engineFixture('ffmpeg-version-8.0-brew.txt'),
})
await writeFakeTool(bin, 'ffprobe', {
  argv: PROBE_ARGV.ffprobe,
  stdout: engineFixture('ffprobe-version-8.0-brew.txt'),
})
const dirs = await serverEnv(tempDir)
console.log(`[e2e-server] Fake engine in ${bin}, UI from ${webDist}`)

server = spawn(process.execPath, ['src/index.ts'], {
  cwd: SERVER_DIR,
  env: { PATH: bin, PORT: String(port.data), DJS_WEB_DIST: webDist, ...dirs },
  stdio: ['ignore', 'inherit', 'inherit'],
})
server.once('error', (error) => fail(`Cannot start the server: ${error.message}`))
server.once('exit', (code, signal) => process.exit(exitCodeFor(code, signal)))
