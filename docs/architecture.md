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
| dev | `pnpm dev` | Vite on `localhost:5173` (HMR), proxying `/api` to the server on `127.0.0.1:4747` (`node --watch src/index.ts --dev`) |
| prod | `pnpm start` | the server on `127.0.0.1:4747` (`node src/index.ts`), serving the built SPA and `/api`; opens the browser |

The server runs its TypeScript source directly on Node, with no build step (ADR-009). Config comes from env, validated with Zod at boot (`config.ts`):
- `PORT`: default 4747, allowed 1024–65535. Browsers drop default ports such as 80 from `Host`, which the guard would then reject. The rule is `PortSchema` in `packages/shared`, and the Vite proxy reads `PORT` with it too, so `PORT=… pnpm dev` moves both ends.
- `YTDLP_PATH`: an absolute path to the yt-dlp binary.
- `FFMPEG_PATH`: an absolute path to the ffmpeg binary, or to a directory holding ffmpeg and ffprobe, as with `--ffmpeg-location`.
- `DJS_DATA_DIR` (planned), which overrides the app data dir (tests use it).
- An empty variable counts as unset. The `--dev` flag (set by `pnpm dev`) also trusts the Vite dev server on port 5173 (see Security model).

## Workspace & tooling
The reasons are in ADR-007.
- **Scripts.** Each root script delegates to the package scripts of the same name.
  - `dev`, `build`, `typecheck` and `test` run in every package that defines them (`pnpm -r --if-present run …`). `build` runs in dependency order.
  - `start` and `smoke` run in `@dj-scraper/server`, and `test:e2e` runs in `@dj-scraper/web`. Each fails if its package doesn't exist.
  - Biome (`check`, `check:fix`) runs from the root with the root `biome.json`. Scope it by path, not with `--filter`: `pnpm check apps/web`.
  - Generated code isn't linted: `routeTree.gen.ts` is skipped entirely, and `apps/web/src/components/ui/` (shadcn/ui) is formatted but not linted. Tool-owned `.claude/settings.json` and `.mcp.json` are skipped.
- **pnpm.**
  - The version is pinned in `packageManager`.
  - Settings live in `pnpm-workspace.yaml`; since pnpm 11, `.npmrc` holds only auth.
  - Dependency versions shared across packages go in its `catalog`, and packages reference them as `"catalog:"`. A package that builds its own Zod schemas depends on `zod` itself (from the catalog), so the workspace keeps one Zod instance.
  - A dependency that runs an install script needs an `allowBuilds` entry, or `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.
  - `devEngines.runtime` makes pnpm refuse any Node version outside `^24.11.0` (the Node 24 LTS line).
- **TypeScript.** Every package extends `tsconfig.base.json` and is checked with `tsc` (TS 7); tsc never emits. The source must run unchanged under Vite, Vitest and Node's type stripping:
  - relative imports end in `.ts`/`.tsx` (Biome's `useImportExtensions`; `check:fix` adds them)
  - type-only imports use `import type` (`verbatimModuleSyntax`)
  - no enums, namespaces or constructor parameter properties (`erasableSyntaxOnly`); use `as const` objects or `z.enum` instead
  - globals are opt-in per package: the server adds `types: ["node"]`, and the web adds `lib: ["es2024", "dom"]` and `types: ["vite/client"]`. `packages/shared` gets none, so Node and DOM globals, including `URL` and `console`, are type errors there. Declare the few WHATWG globals it needs in a local `.d.ts`.
- **Web app (`apps/web`).**
  - Two tsconfigs, both checked by `typecheck`: `tsconfig.json` for `src` (`module: preserve`, so bundler resolution, plus the `@/*` → `src/*` alias shadcn/ui expects) and `tsconfig.node.json` for the Node-side files (`vite.config.ts`, `vitest.config.ts`, `dev-guard.ts`). Our own imports keep the extension, also through the alias (`@/lib/api.ts`); generated shadcn/ui files don't.
  - TanStack Router's Vite plugin writes `src/routeTree.gen.ts` on `dev` and `build`. It is committed, because `tsc` needs it, and its temp dir `.tanstack/` is ignored.
  - Vitest has its own `vitest.config.ts` without the router and Tailwind plugins, so test runs never rewrite the route tree.
  - `pnpm build` makes one ~570 kB bundle (react-dom, zod, Base UI, TanStack). It loads from localhost, so there is no vendor splitting, and the chunk-size warning starts at 1 MB.

## Server modules (`apps/server/src`)
| Module | Responsibility |
|---|---|
| `index.ts` | boot, engine check at startup (logs shared `healthProblems`), graceful shutdown (cancel jobs, kill process groups) |
| `config.ts` | env + `--dev` → `Config`, Zod-validated |
| `server.ts` | `startServer`: `node:http` + Hono's request listener on `127.0.0.1`; listen errors reject; `close()` also drops open connections |
| `app.ts` | Hono app: guard first, then routes, `notFound` and `onError` |
| `http/guard.ts` | Host/Origin/Fetch-Metadata guard and JSON-only mutations; with `--dev` it also trusts the Vite port (see Security model) |
| `http/errors.ts` | `ApiError`, the `ErrorCode` → HTTP status map, error and 404 handlers |
| `routes/*` | thin HTTP layer: validate with shared schemas → call a service → respond |
| `engine/binaries.ts` | locate yt-dlp/ffmpeg/ffprobe and a JS runtime, probe their versions → `Health` |
| `engine/versions.ts` | pure: version output → version, release date, major, checked against the minimums from `@dj-scraper/shared` |
| `engine/health.ts` | cached health check (10 min, one probe at a time) |
| `engine/run.ts` | the **only** place that spawns processes: argv only, detached process group, line streaming, abort, timeout |
| `engine/ytdlp-args.ts` | pure: (url, options) → argv |
| `engine/ytdlp-parse.ts` | pure: info JSON → Track/Collection, `DL`/`PP`/`DONE` lines → events, stderr → `ErrorCode` |
| `engine/finalize.ts` | after yt-dlp: artist/title + filename (pure), tags and AIFF via ffmpeg, safe move into the target folder |
| `jobs/queue.ts` | download queue: concurrency, per-platform pacing/back-off, state machine, cancel/retry |
| `jobs/bus.ts` | typed event emitter feeding SSE |
| `settings/` | load/save settings JSON (Zod-validated, defaults filled on read) |
| `fs/` | native folder picker (macOS `osascript` "choose folder"), path safety, filename sanitizing |

## Web modules (`apps/web`)
| Module | Responsibility |
|---|---|
| `vite.config.ts` | dev server (port 5173, `strictPort`, `cors: false`, anti-framing headers, `/api` proxy keeping the browser's Host), router/React/Tailwind plugins |
| `dev-guard.ts` | dev-server plugin: the guard's exact Host check and Fetch Metadata rule for every request Vite answers; `/__open-in-editor` only from the page itself |
| `src/main.tsx` | mounts the app: QueryClient, router with `{ queryClient }` context |
| `src/routes/__root.tsx` | the shell: header (app name, engine status), `<Outlet/>`, not-found page |
| `src/routes/index.tsx` | home: the paste flow (Phase 3); an empty state for now |
| `src/lib/api.ts` | the only `fetch` caller: same-origin `/api`, JSON `Content-Type` on every non-GET, shared-schema validation, `ApiError` (`api` / `unreachable` / `invalid_response`) |
| `src/features/engine/` | `useHealth` (query `['health']`, retried every 3 s only while failing) and `useRecheckHealth`; the header chip and popover (`EngineStatus`) listing tools, versions and `healthProblems` |
| `src/components/ui/` | shadcn/ui components (Base UI, Nova), generated by the CLI |
| `src/test/` | test helpers: fake `fetch` at the network edge, Health fixtures, render with a fresh QueryClient, the console guard |

## API (v1)
JSON bodies are validated with the shared schemas. Errors use the shape `{ error: { code: ErrorCode, message } }` (`ApiErrorBody`) with the status from `http/errors.ts`: 400 `invalid_url`/`invalid_request`, 403 `forbidden`, 404 `not_found`, 409 `canceled`, 415 `invalid_request` for a non-JSON mutation, 422 `unsupported_url` and content the platform refuses (`unavailable`, `private`, `geo_blocked`, `age_restricted`, `login_required`, `bot_check`, `preview_only`), 429 `rate_limited`, 502 `network`, 503 `engine_missing`, 500 `postprocess_failed`/`unknown`.

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | – | `Health` (cached up to 10 min): per tool `ok`/`missing`/`error` with path, version and minimum checks, yt-dlp age, JS runtimes, overall `ok` |
| `POST /api/health/recheck` | – | `Health`, probed now (e.g. after installing yt-dlp) |
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
The schemas in `packages/shared/src` are authoritative. The first block below summarizes them; the second is still a sketch for Phase 1–2.

```ts
// Implemented (packages/shared/src). Every URL field accepts http(s) only.
type Platform = 'youtube' | 'soundcloud' | 'other'

type Track = {
  id: string                  // platform id from yt-dlp
  platform: Platform
  url: string                 // canonical page URL (a partial row's may be an API URL)
  title: string
  artist?: string             // platform metadata, else parsed from the title
  uploader?: string
  durationSec?: number
  thumbnailUrl?: string
  availability: 'available' | 'unavailable' | 'unknown'   // 'unknown' is normal in flat listings
  unavailableReason?: 'unavailable' | 'private' | 'geo_blocked' | 'age_restricted' | 'login_required' | 'preview_only'
  source?: { codec?: string; bitrateKbps?: number }        // yt-dlp acodec/abr, known after full extraction
}

// A collection row. Partial rows (e.g. bare SoundCloud set entries) await POST /api/resolve/entries.
type CollectionEntry =
  | (Track & { partial: false })
  | (Omit<Track, 'title'> & { title?: string; partial: true })

type Collection = {
  id: string; platform: Platform; url: string   // identified by url: id repeats across a channel's tabs
  kind: 'playlist' | 'album' | 'set' | 'channel' | 'likes' | 'mix' | 'other'
  title: string; owner?: string; thumbnailUrl?: string
  entries: CollectionEntry[]
}

type ResolveResult =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }
  | { kind: 'ambiguous'; track: Track; collectionUrl: string }  // watch?v=…&list=…

type ErrorCode =
  | 'invalid_url' | 'unsupported_url' | 'unavailable' | 'private' | 'geo_blocked'
  | 'age_restricted' | 'login_required' | 'bot_check' | 'rate_limited' | 'preview_only'
  | 'network' | 'engine_missing' | 'postprocess_failed' | 'canceled'
  | 'invalid_request' | 'forbidden' | 'not_found' | 'unknown'

type ErrorInfo = { code: ErrorCode; message: string }
type ApiErrorBody = { error: ErrorInfo }      // body of every API error response

// GET /api/health (see health.ts for the per-tool fields)
type ToolHealth<Ok> = ({ status: 'ok'; path: string; source: 'env' | 'path'; version: string } & Ok)
  | { status: 'missing'; message: string }
  | { status: 'error'; path: string; source: 'env' | 'path'; message: string }
type Health = {
  ok: boolean; checkedAt: string
  ytdlp: ToolHealth<{ releaseDate: string; ageDays: number; stale: boolean; meetsMinimum: boolean }>
  ffmpeg: ToolHealth<{ major?: number; meetsMinimum: boolean; mp3: boolean }>
  ffprobe: ToolHealth<{ major?: number; meetsMinimum: boolean }>
  jsRuntimes: { name: 'deno' | 'node'; path: string; version: string; supported: boolean }[]
}
```

Pure helpers in `packages/shared`, used by both apps:
```ts
// The engine minimums (engine.ts): YTDLP_MIN_RELEASE '2025-11-12', YTDLP_STALE_AFTER_DAYS 60,
// FFMPEG_MIN_MAJOR 8, DENO_MIN_VERSION [2, 3, 0], NODE_MIN_VERSION [22, 0, 0]

// Readable engine problems, shared by the server's boot log and the web's status popover.
// 'error' exactly when the problem makes Health.ok false; 'warning' for a stale yt-dlp or no MP3 encoder.
healthProblems(health: Health): { tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'js-runtime'; severity: 'error' | 'warning'; message: string }[]

// The guard's Fetch Metadata rule, also applied by the Vite dev server (see Security model).
allowedByFetchMetadata(req: { method: string; site?: string; mode?: string; dest?: string }): boolean
```

```ts
// Sketch (Phase 1–2)
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
  error?: ErrorInfo
}

type ServerEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; jobId: string; progress: NonNullable<Job['progress']> }
  | { type: 'heartbeat' }
```

## Flows

### Resolve
1. Web: `classifyUrl(url)` from shared gives an instant platform/type hint and rejects obviously invalid input.
2. Server: a single `yt-dlp -J --flat-playlist` call, normalized into a `ResolveResult`.
   - YouTube flat entries already carry title, duration, uploader and thumbnails, but no availability: rows stay `unknown` unless the title marks them private or deleted.
   - SoundCloud set entries are bare (id + url), so they arrive as `partial` entries. The web asks `POST /api/resolve/entries` for the partial rows in view, and the server throttles those lookups to respect SoundCloud's API budget.
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
- **The guard** (`http/guard.ts`) runs first on every request, API and static alike, and answers 403 `forbidden` unless:
  - `Host` matches exactly, lowercased. The request URL's host must match too, because Node builds the URL from an absolute-form request target. Duplicate Host headers never match.
  - `Origin`, when present, is our own on **every** method. This check is what stops Safari, which sends a cross-site no-cors POST with a typed Blob body as `application/json` without a preflight.
  - `Sec-Fetch-Site`, when present, is `same-origin` or `none`. The one exception is a top-level navigation GET, so a link to the app still works. This blocks cross-site `<img>`, `<iframe>` and `sendBeacon`. Other localhost ports count as `same-site` and are refused too. The rule is `allowedByFetchMetadata` in `packages/shared`. Browsers send no Fetch Metadata to insecure origins, so it complements the Host and Origin checks and never replaces them.
  - With `--dev` only, the Vite dev port is trusted too: `localhost:5173` and `127.0.0.1:5173` pass as Host and as origin (ADR-011).
- **State-changing routes.** Every method except GET, HEAD and OPTIONS requires `Content-Type: application/json` (415 `invalid_request` otherwise), which forces a CORS preflight that we never approve. Bodyless mutations (cancel, retry) send the header too. Re-checking the engine is a POST for the same reason.
- **No CORS headers**, ever, from the server or from Vite.
- **The Vite dev server** (`apps/web/vite.config.ts`) is attack surface too while `pnpm dev` runs (ADR-011):
  - `cors: false`. Otherwise Vite answers CORS requests and approves preflights from any localhost origin.
  - `strictPort: true`, because the server trusts exactly port 5173.
  - The `/api` proxy keeps the browser's Host (`changeOrigin: false`), so the guard's exact Host check sees `localhost:5173`. Vite's own host check is looser and is not a defense: it lets through a missing Host, any IP literal, `*.localhost`, `file:*`, `*-extension:*` and `localhost:<anything>`, and single-label names such as `file` resolve through the DHCP search domain, so they can be rebound. Never widen it either (no `allowedHosts`, `--host` or https).
  - `server.headers` sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. In dev, Vite serves the page, so the guard's iframe refusal doesn't cover it, and a framed app could be clickjacked into a state-changing click.
  - `dev-guard.ts` applies the guard's rules to every request Vite answers, not just `/api`:
    - The exact Host check. Otherwise a rebinding page at `http://file:5173` could read the repo through `/@fs`, take the HMR token from `/@vite/client` and call `/__open-in-editor`, all same-origin.
    - The Fetch Metadata rule, so other sites and ports can't frame the app or load its modules.
    - Vite's `/__open-in-editor` opens any existing file in the developer's editor, so it is stricter still: even a link from another site is refused. Only the page itself (Vite's error overlay fetches it same-origin) or a non-browser client may call it.
    - HMR's WebSocket upgrade bypasses connect middlewares and keeps Vite's own token check.
  - Vite binds whatever `localhost` resolves to: `[::1]:5173` on macOS. When the server is down, its proxy answers 502 `text/plain` with an empty body, which the web client reports as "Server offline".
  - `apps/web/vite-config.test.ts` pins every setting above, so dropping one fails a test.
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
  - A set override never falls back to `PATH`, so a broken override shows up as an error instead of being silently ignored.
  - ffprobe is looked up beside an `FFMPEG_PATH` binary, as yt-dlp's `--ffmpeg-location` does.
  - The PATH search uses only absolute entries and regular, executable files, and spawns nothing.
- **Minimums:**
  - yt-dlp 2025.11.12, the first release with `--js-runtimes`.
  - ffmpeg and ffprobe 8.
  - deno 2.3 or Node 22, for yt-dlp's EJS.
  - Health's `ok` requires all of these. A stale yt-dlp or an ffmpeg without MP3 support is only a warning.
  - The constants live in `packages/shared/src/engine.ts`. `healthProblems` words what falls short, for the server's boot log and the web's status popover alike.
- **Probes:** `--version`/`-version`, with a 30 s timeout: a onefile `yt-dlp_macos` can take about 12 s to start on a Mac with endpoint security. The probe runs at boot (its warnings are logged), the result is cached, and `POST /api/health/recheck` refreshes it.
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
| Smoke | `pnpm smoke '<url>'` | real yt-dlp against live YouTube/SoundCloud | yes, run by hand |

Web tests (`apps/web`) run in jsdom with Testing Library. They fake `fetch` at the network edge (`src/test/fake-api.ts`) instead of mocking hooks, use a fresh QueryClient per test, and fail on any `console.error` or `console.warn` (React warnings included). Node-side files at the package root (`dev-guard.test.ts`, `vite-config.test.ts`) choose the node environment per file.

Fixtures live in `apps/server/test/fixtures/<platform>/` and `fixtures/engine/` (version probe output). Each is recorded from a real run, with the tool version and date noted in its directory's `README.md`. Fake engine binaries are checked in (`test/fake-tool.sh`) and symlinked per test: endpoint security scans each newly written executable on its first run.
