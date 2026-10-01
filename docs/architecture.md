# Architecture

DJ Scraper is a local web app. A React SPA runs in the browser, and a small Node server on the same machine drives yt-dlp and ffmpeg and writes files to disk. The reasons behind this design are in `docs/decisions.md`. Exact yt-dlp flags are in the `ytdlp` skill.

## System overview

```
Browser: React SPA (apps/web)
  │  JSON over HTTP /api/*            SSE /api/events
  ▼
Local server: Node + Hono (apps/server), 127.0.0.1:4747
  ├─ resolve     yt-dlp -J --flat-playlist → Track | Collection
  ├─ downloads   job queue (paced per platform) → one yt-dlp process per track,
  │              working only in that job's temp dir (ffmpeg: convert, tags, artwork)
  │              → finalize: artist/title, tags, AIFF, filename, move into target folder
  ├─ events      in-process bus → SSE fan-out
  ├─ settings    JSON file in the app data dir
  └─ system      health (binaries, versions, JS runtime), native folder picker, reveal in Finder
  ▼
Filesystem: <target folder>/<Artist - Title>.<ext>
```

`packages/shared` holds the Zod schemas both sides import. It is the contract.

## Runtime & ports
| Mode | Command | What runs |
|---|---|---|
| dev | `pnpm dev` | Vite on `localhost:5173` (HMR), proxying `/api` to the server on `127.0.0.1:4747` (watch mode) |
| prod | `pnpm start` | the server on `127.0.0.1:4747`, serving the built SPA and `/api`; opens the browser |

Config comes from env, validated with Zod at boot:
- `PORT` (default 4747)
- `YTDLP_PATH`, `FFMPEG_PATH`
- `DJS_DATA_DIR`, which overrides the app data dir (tests use it)

## Server modules (`apps/server/src`)
| Module | Responsibility |
|---|---|
| `index.ts` | boot, config, graceful shutdown (cancel jobs, kill process groups) |
| `app.ts` | Hono app: security middleware, error handler, routes |
| `routes/*` | thin HTTP layer: validate with shared schemas → call a service → respond |
| `engine/binaries.ts` | locate yt-dlp/ffmpeg/ffprobe and a JS runtime; read versions |
| `engine/run.ts` | the **only** place that spawns processes: argv only, detached process group, line streaming, abort, timeout |
| `engine/ytdlp-args.ts` | pure: (url, options) → argv |
| `engine/ytdlp-parse.ts` | pure: info JSON → Track/Collection, `DL`/`PP`/`DONE` lines → events, stderr → `ErrorCode` |
| `engine/finalize.ts` | after yt-dlp: artist/title + filename (pure), tags and AIFF via ffmpeg, safe move into the target folder |
| `jobs/queue.ts` | download queue: concurrency, per-platform pacing/back-off, state machine, cancel/retry |
| `jobs/bus.ts` | typed event emitter feeding SSE |
| `settings/` | load/save settings JSON (Zod-validated, defaults filled on read) |
| `fs/` | native folder picker (macOS `osascript` "choose folder"), path safety, filename sanitizing |

## API (v1)
JSON bodies are validated with the shared schemas. Errors use the shape `{ error: { code: ErrorCode, message } }` with a matching HTTP status.

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | – | `Health`: path and version of yt-dlp, ffmpeg and ffprobe (or missing), JS runtime, yt-dlp age in days |
| `POST /api/resolve` | `{ url, mode?: 'auto' \| 'track' \| 'collection' }` | `ResolveResult` |
| `POST /api/resolve/entries` | `{ urls: string[] }` | `Track[]` (lazy enrichment, e.g. bare SoundCloud set entries) |
| `POST /api/downloads` | `{ items: TrackRef[], folder, options: DownloadOptions }` | `{ batchId, jobs: Job[] }` |
| `GET /api/downloads` | – | `Job[]` for this server session |
| `POST /api/downloads/:id/cancel` | – | `Job` |
| `POST /api/downloads/:id/retry` | – | `Job` |
| `POST /api/downloads/:id/reveal` | – | `204`; reveals the job's output file in Finder |
| `GET /api/events` | – | SSE stream of `ServerEvent` |
| `GET /api/settings`, `PUT /api/settings` | `Settings` | `Settings` |
| `POST /api/folders/pick` | `{ startIn?: string }` | `{ path }` or `{ canceled: true }` |

## Domain model (`packages/shared`)
This is a starting sketch. Once the Zod schemas exist, they are authoritative.

```ts
type Platform = 'youtube' | 'soundcloud' | 'other'

type Track = {
  id: string                  // platform id from yt-dlp
  platform: Platform
  url: string                 // canonical page URL
  title: string
  artist?: string             // platform metadata, else parsed from the title
  uploader?: string
  durationSec?: number
  thumbnailUrl?: string
  availability: 'available' | 'unavailable' | 'unknown'
  unavailableReason?: string
  source?: { codec?: string; bitrateKbps?: number }  // known after full extraction
}

type Collection = {
  id: string; platform: Platform; url: string
  kind: 'playlist' | 'album' | 'set' | 'channel' | 'likes' | 'mix' | 'other'
  title: string; owner?: string; thumbnailUrl?: string
  entries: Track[]            // may be partial (e.g. SoundCloud) until enriched
}

type ResolveResult =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }
  | { kind: 'ambiguous'; track: Track; collectionUrl: string }  // watch?v=…&list=…

type DownloadOptions = {
  format: 'mp3' | 'm4a' | 'aiff' | 'wav' | 'flac' | 'original'
  embedArtwork: boolean
  filenameTemplate: string     // default '{artist} - {title}'
  subfolder?: string           // e.g. the playlist title
}

type JobStatus = 'queued' | 'downloading' | 'processing' | 'done' | 'failed' | 'canceled' | 'skipped'

type Job = {
  id: string; batchId: string; track: TrackRef; status: JobStatus
  progress?: { percent: number; speedBps?: number; etaSec?: number; waitingSec?: number }
  outputPath?: string
  error?: { code: ErrorCode; message: string }
}

type ServerEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; jobId: string; progress: NonNullable<Job['progress']> }
  | { type: 'heartbeat' }

type ErrorCode =
  | 'invalid_url' | 'unsupported_url' | 'unavailable' | 'private' | 'geo_blocked'
  | 'age_restricted' | 'login_required' | 'bot_check' | 'rate_limited' | 'preview_only'
  | 'network' | 'engine_missing' | 'postprocess_failed' | 'canceled' | 'unknown'
```

## Flows

### Resolve
1. Web: `classifyUrl(url)` from shared gives an instant platform/type hint and rejects obviously invalid input.
2. Server: a single `yt-dlp -J --flat-playlist` call, normalized into a `ResolveResult`.
   - YouTube flat entries already carry title, duration, uploader and thumbnails.
   - SoundCloud set entries are bare (id + url). The web asks `POST /api/resolve/entries` for the rows in view, and the server throttles those lookups to respect SoundCloud's API budget.
3. Special cases:
   - `watch?v=…&list=…` returns `ambiguous` unless the request sets `mode`.
   - YouTube Mix/Radio (`list=RD…`) never ends: treat it as a single track unless asked, and cap its entries.

### Download
1. `POST /api/downloads` validates the folder (absolute, and exists or can be created) and enqueues one job per track.
2. The queue runs up to `concurrency` jobs (default 3), paced per platform. On `rate_limited`, that platform's queue pauses and resumes later.
3. **yt-dlp step.** Each job gets its own temp dir under the app data dir. One yt-dlp process:
   - downloads the best audio there and converts it (MP3 320 CBR, M4A copy, FLAC, WAV, or the original)
   - embeds artwork where the container supports it
   - streams progress lines
   - prints the final file path plus metadata as JSON
4. **Finalize step (ours).**
   - Decide artist/title: platform fields, else split the title at the first dash, then apply clean-up rules.
   - Write tags (comment = source URL).
   - For AIFF, convert with ffmpeg (yt-dlp can't), adding ID3v2 tags and cover art.
   - Build and sanitize the filename, then verify the path is inside the target folder. If a file already exists there, the job ends as `skipped`.
   - Otherwise move the file in: `rename`, or copy + unlink across volumes (USB drives).
5. Every state change goes to the bus, then out over SSE, and the web merges it into the query cache. Progress events are throttled to about 4/s per job. YouTube's enforced pre-download sleep is reported as `waitingSec`.
6. **Cancel.** SIGINT to the job's process group (yt-dlp then stops its ffmpeg child), then SIGKILL after a grace period, then delete the job's temp dir. Retry re-queues a failed or canceled job. At startup, stale job dirs are removed.

### Job state machine
```
queued → downloading → processing → done
   │          │             │
   └──────────┴─────────────┴──→ failed | canceled
queued → skipped                (file exists / already in archive)
failed | canceled → queued      (retry)
```
A job settles exactly once per attempt.

## Security model (local server)
The server can spawn processes and write files, so other websites must not be able to drive it.
- **Bind and Host.** Bind `127.0.0.1` only. Reject any request whose `Host` isn't `localhost:<port>` or `127.0.0.1:<port>`; this stops DNS rebinding.
- **State-changing routes:**
  - They require `Content-Type: application/json`, which forces a CORS preflight that we never approve.
  - When an `Origin` is present, it must be our own (plus the Vite dev origin in dev).
  - The server never sends CORS headers.
- **Processes.** Argv arrays only (`shell: false`), with `--ignore-config`. The URL is validated (http/https, length cap) and passed after `--`.
- **Paths.** yt-dlp writes only into the job's temp dir. Finalize resolves the final path, asserts it is inside the target folder, and sanitizes the filename for macOS and Windows.
- **Secrets:**
  - Sign-ins are opt-in and per platform. yt-dlp reads browser cookies at runtime, and the app never stores cookies.
  - Secrets never go into argv (visible in `ps`) or logs.

## Persistence
App data dir: `~/Library/Application Support/DJ Scraper/` on macOS.
- **Settings:** `settings.json` in the app data dir, Zod-validated with defaults filled in on read.
- **Job temp dirs:** `jobs/<jobId>/` in the app data dir, deleted after finalize or cancel and swept at startup.
- **Download archive** (dedupe, Phase 4): a yt-dlp `--download-archive` file in the app data dir.
- **Jobs:** kept in memory for the server session. Persistent history comes in Phase 4.
- **Default target folder:** `~/Music/DJ Scraper`.

## Engine binaries
- **Lookup order:** `YTDLP_PATH` / `FFMPEG_PATH`, then `PATH` (Homebrew). `/api/health` reports what it found.
- **JS runtime:** YouTube needs one. Brew's yt-dlp depends on deno, and we always add `--js-runtimes node:<process.execPath>` as a fallback.
- **Freshness:** yt-dlp versions are dates (e.g. `2026.08.19`), so its age is easy to compute. Warn past ~60 days.
  - When YouTube breaks, the fix is usually a newer yt-dlp.
  - If stable lags, point `YTDLP_PATH` at a nightly build.
- **Details:** exact flags, output parsing and platform quirks live in the `ytdlp` skill (`.claude/skills/ytdlp/`).

## Testing
| Layer | Tool | Scope | Network |
|---|---|---|---|
| Unit | Vitest | shared helpers and schemas, argv builders, parsers, error mapping, finalize naming/tagging logic, queue state machine, hooks/components | never |
| Integration | Vitest | real server + `test/fake-yt-dlp.mjs` replaying fixtures: spawn, progress, cancel, errors, finalize | never |
| E2E | Playwright | UI flows against the server + fake engine | never |
| Smoke | `pnpm smoke <url>` | real yt-dlp against live YouTube/SoundCloud | yes, run by hand |

Fixtures live in `apps/server/test/fixtures/<platform>/`. Each is recorded from a real run, with the yt-dlp version and date noted.
