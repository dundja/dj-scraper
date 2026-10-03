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
  │              downloading the stream as is into that attempt's temp dir
  │              → finalize: ffprobe, one ffmpeg pass (convert, tags, cover), read back, our ID3 tag
  │              → publish into the target folder, never overwriting
  ├─ events      in-process bus → SSE fan-out, each stream starting with a snapshot
  ├─ settings    settings.json in the app data dir
  └─ system      health (binaries, versions, JS runtime), native folder picker, reveal in Finder
  ▼
Filesystem: <target folder>/[<subfolder>/]<Artist - Title>.<ext>
```

`packages/shared` holds the Zod schemas both sides import. It is the contract.

## Runtime & ports
| Mode | Command | What runs |
|---|---|---|
| dev | `pnpm dev` | Vite on `localhost:5173` (HMR), proxying `/api` to the server on `127.0.0.1:4747` (`node --watch src/index.ts --dev`) |
| prod | `pnpm start` | `pnpm build` (the web app), then the server on `127.0.0.1:4747` (`node src/index.ts --open`), serving the built SPA and `/api`, and opening it in the default browser |

The server runs its TypeScript source directly on Node, with no build step (ADR-009). Config comes from env, validated with Zod at boot (`config.ts`):
- `PORT`: default 4747, allowed 1024–65535. Browsers drop default ports such as 80 from `Host`, which the guard would then reject. The rule is `PortSchema` in `packages/shared`, and the Vite proxy reads `PORT` with it too, so `PORT=… pnpm dev` moves both ends.
- `YTDLP_PATH`: an absolute path to the yt-dlp binary.
- `FFMPEG_PATH`: an absolute path to the ffmpeg binary, or to a directory holding ffmpeg and ffprobe, as with `--ffmpeg-location`.
- `DJS_WEB_DIST`: an absolute path to the built UI. The default is `apps/web/dist`, found from the server's source location rather than the cwd (ADR-009). Tests and the e2e server set it.
- `DJS_DATA_DIR`: an absolute path to the app data dir, instead of `~/Library/Application Support/DJ Scraper`. Tests give every spawned server its own.
- The home folder (`os.homedir()`, so `HOME` when set) must be absolute. The default data dir and the default download folder, `~/Music/DJ Scraper`, are in it.
- An empty variable counts as unset.
- Flags:
  - `--dev` (set by `pnpm dev`) also trusts the Vite dev server on port 5173 (see Security model). The server then serves no UI, because Vite does. It also checks every SSE event against the contract.
  - `--open` (set by `pnpm start`) opens `http://127.0.0.1:<port>/` once listening. On macOS that runs `/usr/bin/open <url>` through `engine/run.ts`; elsewhere it logs the URL. A failure only warns. It is ignored with `--dev`.
- Outside `--dev`, a missing `index.html` in the web dist prints one warning at boot. The API keeps working, and pages answer 404 `not_found` saying to run `pnpm build`.

Boot order (`index.ts`): config → prepare the data dir → take its lock (a second server waits up to 9 s for the first to stop, then exits 1) → sweep what a previous server left → settings → services → listen. Shutdown (`shutdown.ts`, on SIGINT, SIGTERM or SIGHUP, within 8 s): stop the queue and end the event streams together, then flush the settings, close the server and release the lock (ADR-018).

## Workspace & tooling
The reasons are in ADR-007.
- **Scripts.** Each root script delegates to the package scripts of the same name.
  - `dev`, `build`, `typecheck` and `test` run in every package that defines them (`pnpm -r --if-present run …`). `build` runs in dependency order, but only `apps/web` defines it so far (ADR-009).
  - `start` first runs `pnpm build`, so it never serves a stale UI, then the server's `start` (`node src/index.ts --open`). `smoke` runs in `@dj-scraper/server`, and `test:e2e` runs in `@dj-scraper/web`. Each fails if its package doesn't exist.
  - Biome (`check`, `check:fix`) runs from the root with the root `biome.json`. Scope it by path, not with `--filter`: `pnpm check apps/web`.
  - Generated code isn't linted: `routeTree.gen.ts` is skipped entirely, and `apps/web/src/components/ui/` (shadcn/ui) is formatted but not linted. Tool-owned `.claude/settings.json` and `.mcp.json` are skipped.
  - Test fixtures from `@dj-scraper/shared/test-helpers` (`testUuid`, refs, jobs) are for tests only: `noRestrictedImports` refuses them in runtime code (the packages' `src/` and the server's `scripts/`, except `*.test.ts(x)` and `apps/web/src/test/`).
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
  - Three tsconfigs, all checked by `typecheck`:
    - `tsconfig.json` for `src`: `module: preserve`, so bundler resolution, plus the `@/*` → `src/*` alias shadcn/ui expects.
    - `tsconfig.node.json` for the Node-side files: the Vite and Vitest configs and the dev-server plugins.
    - `tsconfig.e2e.json` for `playwright.config.ts` and `e2e/`: Node types plus the DOM lib, because `page.evaluate` callbacks run in the browser.
  - Our own imports keep the extension, also through the alias (`@/lib/api.ts`). Generated shadcn/ui files don't.
  - TanStack Router's Vite plugin writes `src/routeTree.gen.ts` on `dev` and `build`. It is committed, because `tsc` needs it, and its temp dir `.tanstack/` is ignored.
  - Vitest has its own `vitest.config.ts` without the router and Tailwind plugins, so test runs never rewrite the route tree.
  - `pnpm build` makes one ~570 kB bundle (react-dom, zod, Base UI, TanStack). It loads from localhost, so there is no vendor splitting, and the chunk-size warning starts at 1 MB.

## Server modules (`apps/server/src`)
| Module | Responsibility |
|---|---|
| `index.ts` | boot in order (config, data dir, lock, sweep, settings, services, listen), engine check at startup (logs shared `healthProblems`), signal handling with an 8 s shutdown deadline |
| `shutdown.ts` | the graceful shutdown order, shared by `index.ts` and the downloads test harness: queue and event streams, then settings, the server, the lock |
| `services.ts` | `createServices`: the resolver, the enricher, the download pipeline (gates, queue, attempt, finalize, publish), the bus and the event streams, wired once for the server, `pnpm smoke --download` and the downloads test harness; `productionPacing` gives lookups and downloads one SoundCloud bucket (D8). Tests override only pacing, timers and the bus |
| `config.ts` | env + `--dev`/`--open` → `Config`, Zod-validated, incl. `dataDir` and `homeDir`; `defaultDataDir`, `defaultDownloadFolder` |
| `data-dir.ts` | `prepareDataDir` (real dirs owned by us, 0700), `lockDataDir` (`server.lock`), `sweepLeftovers` with the pure `parsePs`/`leftoverGroups` (ADR-018) |
| `startup.ts` | after listening: the missing-UI warning and `--open` |
| `server.ts` | `startServer`: `node:http` + Hono's request listener on `127.0.0.1`; listen errors reject; `close()` also drops open connections |
| `app.ts` | Hono app, in this order: security headers, guard, `/api` routes, the built UI (not with `--dev`), `notFound` and `onError` |
| `stubs.ts` | `UNUSED_*` deps for tests of one route (`createApp` needs every service) |
| `http/security-headers.ts` | anti-framing, `nosniff` and `no-referrer` headers on every response (see Security model) |
| `http/guard.ts` | Host/Origin/Fetch-Metadata guard and JSON-only mutations; with `--dev` it also trusts the Vite port (see Security model) |
| `http/errors.ts` | `ApiError` (code, message, optional `status` override), the `ErrorCode` → HTTP status map, error and 404 handlers |
| `http/json.ts` | `readJson(c, Schema)` (malformed JSON or a failed Zod check → 400 `invalid_request`), `jsonBodyLimit` (64 KiB) and `jsonBodyLimitOf(bytes)` for bigger bodies |
| `routes/*` | thin HTTP layer: validate with shared schemas → call a service → respond. `system.ts` (health, recheck), `resolve.ts` (resolve, entries), `downloads.ts`, `events.ts` (SSE), `settings.ts`, `folders.ts`, and `web.ts` (next row) |
| `routes/web.ts` | serves the built UI and the SPA fallback (see Security model) |
| `engine/binaries.ts` | locate yt-dlp/ffmpeg/ffprobe and a JS runtime, probe their versions → `Health`; `locateEngine` finds the three tools for a download without running them |
| `engine/versions.ts` | pure: version output → version, release date, major, checked against the minimums from `@dj-scraper/shared` |
| `engine/health.ts` | cached health check (10 min, one probe at a time) |
| `engine/run.ts` | the **only** place that spawns processes: argv only, detached process group, line streaming, abort, timeout; the group is SIGKILLed when a run closes |
| `engine/ytdlp-args.ts` | pure: the base argv every call shares; resolve, entry and download argv; the download selectors |
| `engine/ytdlp-parse.ts` | pure: info JSON → Track/Collection, read with tolerant schemas and checked against the contract; `trackNames`, shared with finalize |
| `engine/ytdlp-progress.ts` | pure: one download line → DL progress, PP, START or DONE; `waitingUntil` |
| `engine/ytdlp-errors.ts` | pure: yt-dlp stderr + exit code → `ErrorInfo` with a human message, from ordered pattern tables backed by fixtures; `mapDownloadExit` for downloads (transfer errors, the preview break filter's exit 101) |
| `engine/finalize-plan.ts` | pure: tags and the comment rule, file name, codec plan and muxer table, ffmpeg/ffprobe argv, ffprobe JSON, output checks, ffmpeg's error text, cover sniffing (ADR-015, ADR-016) |
| `engine/id3.ts` | pure: our ID3v2.3 tag (TIT2, TPE1, TALB, TPE2, TYER, COMM, APIC) and the AIFF `ID3 ` chunk |
| `engine/finalize.ts` | the downloaded file → a tagged file in the target format: probe, cover pass, audio pass, read back, ID3 tag |
| `fs/folders.ts` | `resolveTargetFolder` (at enqueue), `recheckFolder` (at publish), `insideFolder`, the path byte budget |
| `fs/move.ts` | `createPublish`: link, or copy and claim, into the target folder, never overwriting (ADR-018) |
| `fs/folder-picker.ts` | the macOS folder picker (osascript `choose folder`), one at a time, 300 s timeout |
| `fs/reveal.ts` | `open -R` on a finished file |
| `jobs/types.ts` | `StartInfo`, `DoneInfo`, `TargetFolder`, the attempt, finalize and publish signatures, `PartRecord`, `StepError` |
| `jobs/attempt.ts` | one attempt of one job: job dir, yt-dlp, its lines → updates, finalize, publish, cleanup |
| `jobs/queue.ts` | jobs and batches, dedupe, run order, concurrency, gates, the state machine, cancel/retry/clear, eviction of finished jobs |
| `jobs/bus.ts` | typed event bus: each event serialized once for every listener, checked against the contract when asked |
| `pacing/token-bucket.ts` | GCRA token bucket with an optional reserve; one instance can be shared |
| `pacing/gates.ts` | per-platform admission for downloads: bucket, cooldown, strikes, half-open, persistent block (ADR-017) |
| `settings/store.ts` | `settings.json`: field-wise repair on read, atomic coalesced writes, recent folders |
| `util/errno.ts`, `util/fields.ts` | `errnoCode` and `failureName` (an error's code or name for logs, never its message); `lenient` and `omitUndefined` for tool JSON and optional fields |
| `resolve/plan.ts` | pure: classified URL + mode → what to ask yt-dlp (URL, playlist flag, entry cap, timeout, `ambiguous` wrapping) |
| `resolve/resolver.ts` | `POST /api/resolve`: plan → one yt-dlp call → normalize → contract check; at most 4 at a time |
| `resolve/enricher.ts` | `POST /api/resolve/entries`: per-row lookups with per-platform pacing, SoundCloud's request budget (shared with downloads), rate-limit cooldown and a 30 min cache; `peek` reads the cache for the downloads route |
| `resolve/limiter.ts`, `lru.ts`, `input.ts`, `ytdlp-call.ts` | FIFO limiter (concurrency, min gap between starts, an optional token bucket of its own or a shared one, abortable waits, a bypass for answers from cache), TTL/LRU cache, URL checks shared by both services and the downloads route, one yt-dlp call → JSON or `ErrorInfo` |

## Web modules (`apps/web`)
| Module | Responsibility |
|---|---|
| `vite.config.ts` | dev server (port 5173, `strictPort`, `cors: false`, anti-framing headers, `/api` proxy keeping the browser's Host and ending a response the server cut off), router/React/Tailwind plugins |
| `dev-guard.ts` | dev-server plugin: the guard's exact Host check and Fetch Metadata rule for every request Vite answers; `/__open-in-editor` only from the page itself |
| `dev-exit.ts` | dev-server plugin: Ctrl-C (SIGINT) or SIGTERM closes Vite and exits 0, so `pnpm dev` ends cleanly (Vite alone dies by SIGINT and exits 143 on SIGTERM) |
| `playwright.config.ts`, `e2e/` | Playwright e2e against `apps/server/test/e2e-server.ts` (see Testing) |
| `src/main.tsx` | mounts the app: QueryClient, router with `{ queryClient }` context; starts the event stream once (`startEvents`), outside React |
| `src/routes/__root.tsx` | the shell: header (app name, engine status), `<Outlet/>`, not-found page |
| `src/routes/index.tsx` | home: the paste flow (Phase 3); an empty state for now |
| `src/lib/api.ts` | the only `fetch` caller: same-origin `/api`, JSON `Content-Type` on every non-GET, shared-schema validation, `ApiError` (`api` / `unreachable` / `invalid_response`). Calls for health, resolve, downloads (create, cancel, retry, reveal, bulk cancel/retry/clear), settings and the folder picker; no downloads list call |
| `src/lib/events.ts` | `startEvents`: the one `/api/events` stream → `['downloads']` (`DownloadsState`, never fetched); a drop past 2 s rechecks `['health']`; a hidden tab closes it after 10 s (ADR-019) |
| `src/features/engine/` | `useHealth` (query `['health']`, retried every 3 s only while failing) and `useRecheckHealth`; the header chip and popover (`EngineStatus`) listing tools, versions and `healthProblems` |
| `src/components/ui/` | shadcn/ui components (Base UI, Nova), generated by the CLI |
| `src/test/` | test helpers: fake `fetch` at the network edge, `FakeEventSource`, Health and download fixtures, render with a fresh QueryClient, the console guard |

## API (v1)
JSON bodies are validated with the shared schemas. Errors use the shape `{ error: { code: ErrorCode, message } }` (`ApiErrorBody`) with the status from `http/errors.ts`: 400 `invalid_url`/`invalid_request`, 403 `forbidden`, 404 `not_found`, 409 `canceled`, 413 `invalid_request` for a body over its route's limit (64 KiB unless the route says otherwise), 415 `invalid_request` for a non-JSON mutation, 422 `unsupported_url`, `folder_unavailable` and content the platform refuses (`unavailable`, `private`, `geo_blocked`, `age_restricted`, `login_required`, `bot_check`, `preview_only`), 429 `rate_limited`, 502 `network`, 503 `engine_missing`, 507 `disk_full`, 500 `postprocess_failed`/`unknown`. A route may override the status with `ApiError`'s `status` option: 409 `invalid_request` for a retry that can't run or a second folder picker, and 503 `unknown` while the server shuts down or when too many event streams are open.

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | – | `Health` (cached up to 10 min): per tool `ok`/`missing`/`error` with path, version and minimum checks, yt-dlp age, JS runtimes, overall `ok` |
| `POST /api/health/recheck` | – | `Health`, probed now (e.g. after installing yt-dlp) |
| `POST /api/resolve` | `ResolveRequest`: `{ url, mode?: 'auto' \| 'track' \| 'collection' }` | `ResolveResult`. Errors: 400 `invalid_url`, 422 `unsupported_url` (DRM services, unsupported sites) and the platform's refusals, 429, 502, 503 `engine_missing` |
| `POST /api/resolve/entries` | `ResolveEntriesRequest`: `{ entries: { platform, id, url }[] }`, 1–25 partial rows | `{ results: EntryResult[] }`, one per distinct platform + id in request order: `{ status: 'ok', platform, id, track }` or `{ status: 'error', platform, id, error }`. A failed row never fails the batch; only a missing yt-dlp fails the request (503) |
| `POST /api/downloads` | `DownloadRequest`: `{ items: TrackRef[] (1–5,000), folder, options: DownloadOptions, label? }`, at most 8 MiB | `CreateDownloadsResponse`: `{ batchId?, jobIds, duplicates }`, one job id per item (a duplicate maps to its job). Items that can't download become jobs that fail at once (see Flows > Download). Errors: 400 `invalid_request` (a folder that isn't an absolute path, an unusable subfolder name, a path too long for the file names), 422 `folder_unavailable` (missing, not a folder, not writable, inside the data dir, or blocked by macOS privacy settings, which the message names), 503 `engine_missing` (no job is created), 503 while shutting down |
| `GET /api/downloads` | – | `DownloadsSnapshot` (`{ serverId, jobs, batches, queue }`), for tests and tools; the web uses the event stream |
| `POST /api/downloads/:id/cancel` | – | `Job`: a queued job is canceled; a running one gets `cancelRequested: true` and settles later (see the events); a finished one is unchanged. 404 `not_found` for an unknown id or one that isn't a UUID |
| `POST /api/downloads/:id/retry` | – | `Job`, queued again as its next attempt. 409 `invalid_request` unless it failed or was canceled, or when its link can never download; 404 |
| `POST /api/downloads/:id/reveal` | – | `204`; selects the job's file in Finder (`open -R`; the path comes from the job). 404 `not_found` for an unknown job, one without a file, or a file that is gone |
| `POST /api/downloads/cancel` | `CancelJobsRequest`: `{ target: JobScope }` | `BulkJobsResponse`: `{ count }`; queued and running jobs in scope |
| `POST /api/downloads/retry` | `RetryJobsRequest`: `{ target, statuses?: ('failed' \| 'canceled')[] }`, default `['failed']` | `{ count }`; skips failures retrying can't fix (`isRetryableError`) |
| `POST /api/downloads/clear` | `ClearJobsRequest`: `{ target }` | `{ count }`; removes finished jobs (done, skipped, failed, canceled) |
| `GET /api/events` | – | SSE: `retry: 1000`, then a `snapshot`, then `ServerEvent`s in order, with a `heartbeat` every 15 s (ADR-019). 503 while shutting down or with 32 streams open. HEAD gets the headers only, never a stream |
| `GET /api/settings` | – | `Settings` |
| `PUT /api/settings` | `SettingsUpdate`: any fields except `recentFolders` | `Settings`. A changed `concurrency` resizes the queue at once |
| `POST /api/folders/pick` | `FolderPickRequest`: `{ startIn? }` | `FolderPickResponse`: `{ path }`, or `{ canceled: true }` (the user canceled, 300 s passed, or the browser dropped the request). 409 `invalid_request` while a picker is open, 422 `folder_unavailable` for a picked path that is gone or unusable, 500 `unknown` (e.g. no Mac desktop session) |

Bulk bodies (`/downloads/cancel`, `/retry`, `/clear`) may be up to 512 KiB, enough for 5,000 job ids. Once shutdown has begun, the download mutations (create, cancel, retry, bulk) and new event streams answer 503 ("DJ Scraper is shutting down").

## Domain model (`packages/shared`)
The schemas in `packages/shared/src` are authoritative. The blocks below summarize them.

```ts
// Every URL field accepts http(s) only.
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
  kind: 'playlist' | 'album' | 'set' | 'channel' | 'likes' | 'mix' | 'other'  // SoundCloud release sets are 'album'
  title: string; owner?: string; thumbnailUrl?: string   // owner may be derived (see Flows > Resolve)
  trackCount?: number         // the platform's own count (YouTube playlists/albums, SoundCloud sets)
  durationSec?: number        // the platform's total (SoundCloud sets)
  truncated: boolean          // our entry cap cut the list
  skippedEntries?: number     // rows that aren't tracks, e.g. sets on a SoundCloud user page
  entries: CollectionEntry[]
}

type ResolveRequest = { url: string; mode: 'auto' | 'track' | 'collection' }  // mode defaults to auto
type ResolveResult =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }
  | { kind: 'ambiguous'; track: Track; collectionUrl: string;          // watch?v=…&list=…
      collectionKind: 'playlist' | 'album' | 'mix' }

// POST /api/resolve/entries
type EntryRef = { platform: Platform; id: string; url: string }
type EntryResult =
  | { status: 'ok'; platform: Platform; id: string; track: Track }
  | { status: 'error'; platform: Platform; id: string; error: ErrorInfo }

// Limits: MAX_URL_LENGTH 2048, MAX_ID_LENGTH 256 (Track, EntryRef and EntryResult ids),
// MAX_COLLECTION_ENTRIES 5000, MAX_MIX_ENTRIES 50, MAX_ENTRIES_PER_REQUEST 25

type ErrorCode =
  | 'invalid_url' | 'unsupported_url' | 'unavailable' | 'private' | 'geo_blocked'
  | 'age_restricted' | 'login_required' | 'bot_check' | 'rate_limited' | 'preview_only'
  | 'network' | 'engine_missing' | 'postprocess_failed' | 'disk_full' | 'folder_unavailable'
  | 'canceled' | 'invalid_request' | 'forbidden' | 'not_found' | 'unknown'

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

Downloads, events and settings (`download.ts`, `events.ts`, `settings.ts`, `folder.ts`). Timestamps are ISO strings, ids are UUIDs.
```ts
// An absolute POSIX folder: no ~, no . or .. segments, no trailing slash or control characters, ≤ 1024.
type FolderPath = string

type DownloadFormat = 'mp3' | 'm4a' | 'aiff' | 'wav' | 'flac' | 'original'

// What to download: a full Track or a partial row; only platform, id and url are required. The server
// classifies `url` itself and takes every platform decision from that; the rest is for display.
type TrackRef = {
  platform: Platform; id: string; url: string
  title?: string; artist?: string; uploader?: string     // ≤ 1,000 characters each
  durationSec?: number; thumbnailUrl?: string
  availability?: 'available' | 'unavailable' | 'unknown'
  unavailableReason?: UnavailableReason                  // a ref marked unavailable fails without a download
}

type DownloadOptions = {
  format: DownloadFormat
  filenameTemplate: string    // default '{artist} - {title}'; {artist} {title} {album} {year} {uploader}
                              // {id} {platform}; must name {title} or {id}; no / or \
  embedArtwork: boolean
  sourceUrlComment: boolean   // the public page URL in the comment tag (ADR-016)
  subfolder?: string          // one folder inside `folder`, e.g. the playlist title
}
type DownloadRequest = { items: TrackRef[]; folder: FolderPath; options: DownloadOptions; label?: string }
type CreateDownloadsResponse = { batchId?: string; jobIds: string[]; duplicates: number }

type JobStatus = 'queued' | 'downloading' | 'processing' | 'done' | 'failed' | 'canceled' | 'skipped'
type JobProgress = {          // every field optional: yt-dlp doesn't always know them
  percent?: number; downloadedBytes?: number; totalBytes?: number; speedBps?: number; etaSec?: number
  waitingUntil?: string       // the site makes yt-dlp wait until then (show "waiting")
}
type JobOutput = {            // read back from the written file, never inferred from the format
  ext: string; codec: string; bitrateKbps?: number; sampleRateHz?: number; channels?: number
  encoded: boolean            // false: the downloaded stream was copied as is
}

// Discriminated by status: a field that belongs to one status exists only there.
type Job = {
  id: string; batchId: string
  track: TrackRef             // the request's ref; title, artist, url and artwork become the final values
  format: DownloadFormat; folder: FolderPath   // the resolved folder, subfolder included
  attempt: number; createdAt: string; startedAt?: string
  source?: AudioSource        // the stream yt-dlp downloaded (codec as yt-dlp reports it)
  cancelRequested?: true      // cancel was asked while it ran; done and skipped still stand
} & (
  | { status: 'queued'; lastError?: ErrorInfo }      // requeued after a platform's rate limit
  | { status: 'downloading'; progress?: JobProgress }
  | { status: 'processing' }
  | { status: 'done'; outputPath: string; output: JobOutput; finishedAt: string }
  | { status: 'skipped'; outputPath: string; finishedAt: string }   // the file that was already there
  | { status: 'failed'; error: ErrorInfo; finishedAt: string }
  | { status: 'canceled'; finishedAt: string })

type Batch = { id: string; label?: string; folder: FolderPath; format: DownloadFormat; createdAt: string }
type QueueState = { platforms: {     // only platforms with something to report
  platform: Platform; pausedUntil?: string; pauseCode?: 'rate_limited' | 'bot_check'; nextStartAt?: string }[] }
type DownloadsSnapshot = { serverId: string; jobs: Job[]; batches: Batch[]; queue: QueueState }
//   serverId changes when the server restarts; jobs are in creation order

type JobScope = { scope: 'all' } | { scope: 'batch'; batchId: string } | { scope: 'jobs'; ids: string[] }
type CancelJobsRequest = { target: JobScope }
type RetryJobsRequest = { target: JobScope; statuses: ('failed' | 'canceled')[] }   // default ['failed']
type ClearJobsRequest = { target: JobScope }
type BulkJobsResponse = { count: number }

// GET /api/events: one JSON object per `data:` line, after a raw `retry: 1000`.
type ServerEvent =
  | ({ type: 'snapshot' } & DownloadsSnapshot)        // always first on a connection
  | { type: 'jobs.added'; batch: Batch; jobs: Job[] }
  | { type: 'jobs.updated'; jobs: Job[] }              // status changes and final metadata; one per bulk action
  | { type: 'jobs.removed'; ids: string[]; batchIds: string[] }   // cleared or evicted, and emptied batches
  | { type: 'job.progress'; jobId: string; progress: JobProgress }
  | { type: 'queue.updated'; queue: QueueState }
  | { type: 'heartbeat' }                              // every 15 s

type Settings = {
  folder: FolderPath          // default ~/Music/DJ Scraper, filled in by the server
  recentFolders: FolderPath[] // newest first, ≤ 5; kept by the server
  format: DownloadFormat; filenameTemplate: string; embedArtwork: boolean; sourceUrlComment: boolean
  playlistSubfolder: boolean; concurrency: number   // 1–6, default 3
  autoDownloadSingles: boolean
}
type SettingsUpdate = Partial<Omit<Settings, 'recentFolders'>>
type FolderPickRequest = { startIn?: FolderPath }
type FolderPickResponse = { path: FolderPath } | { canceled: true }

// Limits: MAX_DOWNLOAD_ITEMS 5000, MAX_TRACK_TEXT_LENGTH 1000, MAX_FILENAME_TEMPLATE_LENGTH 200,
// MAX_SUBFOLDER_LENGTH 200, MAX_BATCH_LABEL_LENGTH 200, MAX_PATH_LENGTH 1024, MAX_FILENAME_LENGTH 180,
// MAX_RECENT_FOLDERS 5, MAX_CONCURRENCY 6
```

Pure helpers and constants in `packages/shared`, used by both apps:
```ts
// URLs (classify.ts, artist-title.ts). classifyUrl(text) → ClassifiedUrl (platform, UrlKind, guess,
// ids, collectionKind, channelRoot, embeddedList, secret) or a UrlRejection;
// urlRejectionMessage(reason); splitArtistTitle(title); youtubeListKind(listId); isYoutubeChannelId(id)

// Ports (ports.ts): SERVER_PORT 4747, WEB_DEV_PORT 5173, PortSchema (the PORT env var),
// loopbackHosts(port) (the exact Host values the guards accept)

// The engine minimums (engine.ts): YTDLP_MIN_RELEASE '2025-11-12', YTDLP_STALE_AFTER_DAYS 60,
// FFMPEG_MIN_MAJOR 8, DENO_MIN_VERSION [2, 3, 0], NODE_MIN_VERSION [22, 0, 0]

// Readable engine problems, shared by the server's boot log and the web's status popover.
// 'error' exactly when the problem makes Health.ok false; 'warning' for a stale yt-dlp or no MP3 encoder.
healthProblems(health: Health): { tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'js-runtime'; severity: 'error' | 'warning'; message: string }[]

// The guard's Fetch Metadata rule, also applied by the Vite dev server (see Security model).
allowedByFetchMetadata(req: { method: string; site?: string; mode?: string; dest?: string }): boolean

// Folders and file names (folder.ts, filename.ts, download.ts): normalizeFolderPath(input) (a typed
// or picked folder → FolderPath, or undefined); filenameTemplateProblem(template), templatePlaceholders;
// renderFilename(template, fields), sanitizeFilename(base, ext, fallback), sanitizeFolderName(name)

// Jobs (download.ts): isTerminalStatus(status); isRetryableError(code) (what "Retry failed" retries:
// network, rate_limited, bot_check, unknown, postprocess_failed, engine_missing, disk_full,
// folder_unavailable). DEFAULT_SETTINGS (everything but folder), SSE_RETRY_MS 1000, SSE_HEARTBEAT_MS 15000
```

## Flows

### Resolve
The reasons are in ADR-013 and ADR-014.
1. **Web.** `classifyUrl(text)` from shared gives an instant platform and type badge (`guess`: track, collection, ambiguous or unknown) and rejects invalid input: empty, too long, not http(s), or carrying a username or password.
2. **Server: check.** The same `classifyUrl` validates the URL (400 `invalid_url`). DRM services (Spotify, Apple Music, Amazon Music, Tidal, Deezer, Beatport) get 422 `unsupported_url` without starting yt-dlp.
3. **Server: plan** (`resolve/plan.ts`, pure). It decides the URL, the playlist flag, the entry cap and the timeout:
   - The entry cap is 5,000 (YouTube's own playlist limit) and 50 for a mix. yt-dlp is asked for one row more (`-I 1:<cap+1>`), and getting that extra row is what sets `truncated`. `playlist_count` can't tell, because it is null for channel tabs, mixes and SoundCloud user pages.
   - The timeout is 60 s for a track and 180 s for a list (5,001 rows took 38–56 s live).
   - `watch?v=…&list=…` in `auto` mode is a single `--no-playlist` track lookup, answered as `ambiguous` with the list's `collectionUrl` and `collectionKind`. A mix's `collectionUrl` keeps its seed video (`watch?v=X&list=RDX`), because `playlist?list=RD…` is "unviewable" to yt-dlp; such playlist URLs are rewritten to the watch form. `mode: 'track'` resolves just the track, and `mode: 'collection'` lists the list (`--yes-playlist`).
   - A YouTube channel root lists its tabs, not videos, so it is resolved as `<channel>/videos`. An embed player list (`/embed/videoseries?list=…`) is resolved at its playlist page.
4. **Server: yt-dlp.** One `yt-dlp -J --flat-playlist` call (at most 4 run at once; a closed browser request stops it), normalized by `engine/ytdlp-parse.ts` and checked against `ResolveResultSchema`. A failure maps to an `ErrorCode` through `engine/ytdlp-errors.ts`.
   - YouTube flat rows carry title, duration, uploader and thumbnails, but no availability: they stay `unknown` unless their exact title is `[Private video]` or `[Deleted video]`.
   - SoundCloud set rows are bare (id + url) and user-page rows have no duration, so both arrive as `partial` rows (ADR-008). User pages also list sets: only track rows are kept, and the rest are counted in `skippedEntries`.
   - A SoundCloud set whose `album_type` (yt-dlp's copy of SoundCloud's set type) is `album`, `ep`, `single` or `compilation` is kind `album`, like a YouTube album, whatever URL it came from. Playlists (`album_type: playlist`) stay `set`.
   - `owner` is the list's uploader or channel. SoundCloud user pages report neither, so theirs is the username in the `<username> (<Resource>)` title (`The Royal Concept (All)` → `The Royal Concept`). YouTube Music albums have a null uploader, so theirs is the artist of the `<artist> - Topic` channel that all their rows share; an album by several artists gets no owner.
   - Artist comes from platform metadata (YouTube Music, SoundCloud label tracks), else from the title split at its first dash (`splitArtistTitle`).
   - `source` is the stream a download takes (ADR-017): the last audio-only format, skipping Go+ previews and SoundCloud's login-only original, and on SoundCloud also its Opus stream unless nothing else is left. A track that only has preview formats is `unavailable` with reason `preview_only`, without a duration.
5. **Enrichment.** The web asks `POST /api/resolve/entries` for the partial rows in view. The server looks each row up with `yt-dlp -J --flat-playlist --no-playlist -- <row url>`:
   - Pacing is per platform: two lookups at a time, with a minimum gap between starts. SoundCloud adds a request budget, a burst of 25 lookups refilling one every 5 s. That is about 120 lookups per 10 min, or 360–600 API requests at the measured 3–5 per lookup, within SoundCloud's ~600. SoundCloud downloads take from the same bucket and leave its last 5 tokens to lookups (ADR-017).
   - A `rate_limited` row pauses its platform for 60 s, doubling per consecutive hit up to 10 min. During the pause, rows fail at once without spawning.
   - Results are cached for 30 min (2,000 rows), and concurrent requests for the same row share one lookup. That lookup stops only when every request waiting on it is gone. Rows that are lists are refused.
   - Pacing, budget, cooldown and cache are keyed by the platform of the row's URL, not the `platform` the client sent. Results echo the request's platform and id.
   - Timers use a monotonic clock, so a wall-clock jump can't stall pacing or expire the cache.

### Download
The reasons are in ADR-015 to ADR-019.
1. **Enqueue** (`POST /api/downloads`, `routes/downloads.ts`). The cheap checks come first, so a request that can't work creates no jobs:
   - yt-dlp, ffmpeg and ffprobe are located without running them (`locateEngine`); a missing one is 503 `engine_missing`.
   - The folder is resolved (`fs/folders.ts`): an existing, writable folder outside the data dir. Only the default `~/Music/DJ Scraper` is created when missing. A subfolder becomes one sanitized folder name inside it, created if missing, and may not be a symlink (not even to a folder beside it). The real path plus the longest file name must fit macOS's 1,024-byte path limit, and the folder as given plus the subfolder must stay a valid folder path (1,024 characters), since jobs carry it.
   - Each item's URL is classified with `classifyUrl`. Items repeating another (same classified platform + id) within the request, or a queued or running job with the same folder and format (not one being canceled), map to that job. Display fields the ref lacks are filled from the enricher's cache.
   - Items that can't download become jobs that are failed from the start, with no slot, token or spawn: a refused URL (`invalid_url`, `unsupported_url`), a list URL (`invalid_request`, "This link is a list"), and a ref marked unavailable (its reason, e.g. `preview_only`).
   - The queue emits one `jobs.added` before anything starts, and the folder goes to the front of the settings' `recentFolders`.
2. **Queue** (`jobs/queue.ts`). Jobs keep their creation order for display. Each platform has its own run order, and the oldest runnable job across platforms starts first, while fewer than `concurrency` jobs run (a setting, default 3, at most 6) and the platform's gate admits one (`pacing/gates.ts`, ADR-017). A job is `downloading` and holds its slot and token from the moment it is picked.
3. **Attempt** (`jobs/attempt.ts`). The URL is classified again and must match the queued one; only that classified URL reaches yt-dlp. The attempt gets its own job dir, `<dataDir>/jobs/<attemptId>` (0700).
4. **yt-dlp** downloads the selected stream as is (no `-x`), quiet, with `--progress` and two prints (exact argv in the `ytdlp` skill). `engine/ytdlp-progress.ts` reads its lines:
   - `START` (before the download): the stream picked, which becomes the job's `source`. When its `available_at` is in the future, the site makes yt-dlp wait silently: the job shows `progress.waitingUntil`.
   - `DL`: progress. The percent comes from fragments when there are any (HLS byte estimates jump), else from bytes, and never goes back within an attempt. The first `DL` line ends the wait.
   - `DL` `finished`, or a `PP` line after any `DL`: the job is `processing`.
   - `DONE` (after the move): the file and the metadata finalize needs. Its file and thumbnail paths must be regular files inside the job dir.
   - A `START` with a `playlist_id`, a second `START` or a second `DONE` means the URL is a list: the run is stopped and the job fails `invalid_request`.
   - Exit 0 without a `DONE` line fails `unknown` (a live stream, or a file over 2 GB). Any other exit maps through `mapDownloadExit`; on SoundCloud, exit 101 without an `ERROR:` line is the preview break filter: `preview_only`.
5. **Finalize** (`engine/finalize.ts`, ADR-015), in `<jobDir>/finalize/`:
   - ffprobe the download; an MP3's duration is measured with a copy pass, because ffprobe estimates it without a Xing header. That duration must match the one yt-dlp reported, else `network` ("incomplete").
   - Plan (pure): copy when the source already has the target codec, else encode; tags, file name (cut to the UTF-8 bytes the folder's real path leaves of 1,023) and the comment URL (ADR-016).
   - Cover: when `embedArtwork` is on and the target can hold one, yt-dlp's thumbnail (not a placeholder, sniffed as an image) becomes a baseline JPEG of at most 1000 px. A failure here costs only the artwork.
   - One audio pass (`-xerror` unless the source is MP3, ADR-015). Then ffprobe reads the output back: codec, ffmpeg's tags, the cover, and the duration against the input's. ffmpeg's exit 0 alone is never trusted. A full data drive, reported by yt-dlp or ffmpeg, fails `disk_full`.
   - MP3 and AIFF: our ID3v2.3 tag goes in (ADR-016).
6. **Publish** (`fs/move.ts`, ADR-018). The folder is resolved again and must be the one from enqueue. The file name is then claimed without overwriting: the job ends `done`, or `skipped` when a file of that name is already there.
7. **Cleanup.** The job dir is removed after every attempt, whatever happened, once its process groups are gone (`run.ts` SIGKILLs a run's group as it closes).
8. **Failures.**
   - A rate limit (or a YouTube bot check) sends the job back to the front of its platform's queue with `lastError`, and the gate pauses that platform (ADR-017). A job that itself caused 3 strikes fails; a persistent bot check fails every queued YouTube job.
   - `disk_full` or `folder_unavailable` also fails every queued job for the same target folder, in the same `jobs.updated`. The queue can't tell a full data drive (yt-dlp, ffmpeg, the job dir) from a full target drive, so when the data drive is full, queued jobs for other folders each fail as they start (roadmap follow-up).
   - One failing job never stops the others.
9. **Events.** Every change goes to the bus and out over SSE (ADR-019): `jobs.added`, `jobs.updated` (one event for a bulk action), `jobs.removed`, `job.progress` (one per `DL` line, at most about two a second, no throttle), `queue.updated` (pauses and paced starts). The web applies them to `['downloads']`.
10. **Cancel.** A queued job is canceled at once. A running job gets `cancelRequested` and its attempt is aborted: SIGINT to the process group (yt-dlp, or our ffprobe/ffmpeg), SIGKILL after 3 s, then the job dir is removed. A file that already reached the folder stands, as done or skipped. A job still waiting for its turn to claim a name stops at once.
11. **Retry** puts a failed or canceled job at the back of its platform's queue as its next attempt, with its strikes and transient fields reset. Bulk cancel, retry and clear act on a scope (all, a batch, or job ids). Finished jobs beyond 2,000 are dropped with `jobs.removed`: oldest first, done, skipped and canceled ones before failed ones, and none of a batch that still has jobs to run.
12. **Shutdown** aborts every running attempt (they end canceled) while the event streams end cleanly. **Startup** sweeps what a previous server left: its process groups, job dirs and part files (ADR-018).

### Job state machine
```
queued → downloading → processing → done | skipped
   │          │             │
   │          └─────────────┴──→ failed | canceled
   ├──→ canceled                 (cancel while queued)
   └──→ failed                   (a full disk, a gone folder or a persistent bot check fails the queued jobs it concerns)
(new) → failed                   (refused at enqueue: created failed, never started)
downloading | processing → queued   (rate limit or YouTube bot check: back to the front, lastError set)
failed | canceled → queued          (retry: attempt + 1)
```
- A job settles exactly once per attempt.
- `cancelRequested: true` marks a running job that was asked to stop. When its attempt settles, done and skipped stand, and anything else becomes canceled.
- A rate-limited job is requeued instead of failed until it has caused 3 strikes itself (ADR-017).
- `done` and `skipped` carry `outputPath`; only `done` carries `output`, read back from the file.

## Security model (local server)
The server can spawn processes and write files, so other websites must not be able to drive it.
- **Bind and Host.** Bind `127.0.0.1` only. Reject any request whose `Host` isn't `localhost:<port>` or `127.0.0.1:<port>`; this stops DNS rebinding.
- **The guard** (`http/guard.ts`) runs first on every request, API and static alike, and answers 403 `forbidden` unless:
  - `Host` matches exactly, lowercased. The request URL's host must match too, because Node builds the URL from an absolute-form request target. Duplicate Host headers never match.
  - `Origin`, when present, is our own on **every** method. This check is what stops Safari, which sends a cross-site no-cors POST with a typed Blob body as `application/json` without a preflight.
  - `Sec-Fetch-Site`, when present, is `same-origin` or `none`. The one exception is a top-level navigation GET, so a link to the app still works. This blocks cross-site `<img>`, `<iframe>` and `sendBeacon`. Other localhost ports count as `same-site` and are refused too. The rule is `allowedByFetchMetadata` in `packages/shared`. Browsers send no Fetch Metadata to insecure origins, so it complements the Host and Origin checks and never replaces them.
  - With `--dev` only, the Vite dev port is trusted too: `localhost:5173` and `127.0.0.1:5173` pass as Host and as origin (ADR-011).
- **State-changing routes.** Every method except GET, HEAD and OPTIONS requires `Content-Type: application/json` (415 `invalid_request` otherwise), which forces a CORS preflight that we never approve. That covers every download, settings and folder-picker route. Bodyless mutations (cancel, retry, reveal) send the header too. Re-checking the engine is a POST for the same reason.
- **No CORS headers**, ever, from the server or from Vite.
- **Response headers.** Every response the app produces carries `SECURITY_HEADERS` from `packages/shared`: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. That includes pages, assets, API answers, the event stream, the guard's rejections and errors. The middleware runs before the guard, and the Vite dev server sends the same set.
  - The only exceptions are the empty 400 and 431 that Node's HTTP parser or `@hono/node-server` send before the app runs: a malformed request line, an unparseable Host or URL, oversized headers.
- **The built UI** (`routes/web.ts`, production only) is served behind the guard like everything else. It uses a small file server of our own (ADR-012):
  - A path segment may name a file only if it matches `^[\w-][\w.-]*$`. That rules out dotfiles, `.` and `..`, empty segments, and anything still encoded or decoded into `%`, `\`, NUL or a space. Paths are at most 1024 characters.
  - The file's `realpath` must lie inside the `realpath` of the dist dir, so a symlink can't lead out. Only regular files are served, never a directory listing.
  - SPA fallback: a GET or HEAD outside `/api` whose last segment has no dot gets `index.html`. A missing file with an extension, and anything under `/api`, is 404 `not_found` JSON, never `index.html`.
  - `Cache-Control`: `/assets/*` (Vite's content-hashed files) is `public, max-age=31536000, immutable`; `index.html` and the files from `public/` are `no-cache`. The dist dir is read per request, so a rebuild needs no restart.
- **The Vite dev server** (`apps/web/vite.config.ts`) is attack surface too while `pnpm dev` runs (ADR-011):
  - `cors: false`. Otherwise Vite answers CORS requests and approves preflights from any localhost origin.
  - `strictPort: true`, because the server trusts exactly port 5173.
  - The `/api` proxy keeps the browser's Host (`changeOrigin: false`), so the guard's exact Host check sees `localhost:5173`. Vite's own host check is looser and is not a defense: it lets through a missing Host, any IP literal, `*.localhost`, `file:*`, `*-extension:*` and `localhost:<anything>`, and single-label names such as `file` resolve through the DHCP search domain, so they can be rebound. Never widen it either (no `allowedHosts`, `--host` or https).
  - `server.headers` sends the server's `SECURITY_HEADERS`, including `frame-ancestors 'none'` and `X-Frame-Options: DENY`. In dev, Vite serves the page, so the guard's iframe refusal doesn't cover it, and a framed app could be clickjacked into a state-changing click.
  - `dev-guard.ts` applies the guard's rules to every request Vite answers, not just `/api`:
    - The exact Host check. Otherwise a rebinding page at `http://file:5173` could read the repo through `/@fs`, take the HMR token from `/@vite/client` and call `/__open-in-editor`, all same-origin.
    - The Fetch Metadata rule, so other sites and ports can't frame the app or load its modules.
    - Vite's `/__open-in-editor` opens any existing file in the developer's editor, so it is stricter still: even a link from another site is refused. Only the page itself (Vite's error overlay fetches it same-origin) or a non-browser client may call it.
    - HMR's WebSocket upgrade bypasses connect middlewares and keeps Vite's own token check.
  - Vite binds whatever `localhost` resolves to: `[::1]:5173` on macOS. When the server is down, its proxy answers 502 `text/plain` with an empty body, which the web client reports as "Server offline". When the server dies mid-response, the proxy now destroys the browser's response, so an open event stream sees the drop (ADR-019).
  - `apps/web/vite-config.test.ts` pins every setting above, so dropping one fails a test.
- **Processes.** Argv arrays only (`shell: false`), with `--ignore-config`. The URL is validated by `classifyUrl` (http/https only, at most 2,048 characters, no username or password, since argv shows in `ps`) and passed last, right after `--`. For a download, only the classified URL reaches yt-dlp: the queue classifies the request's URL, and the attempt classifies it again and checks that it matches. Nothing else in the argv comes from the request.
  - ffmpeg and ffprobe get absolute paths inside the job dir only, with `-protocol_whitelist file` before every input; ffmpeg also gets `-nostdin -n` and an explicit `-f`. A download that ffprobe reads as a playlist (hls, dash, concat) is refused, so ffmpeg never follows references in it.
  - Tag values come from the platform's metadata. Each is one argv entry after `-metadata`, cleaned by `cleanTagValue` first (controls become spaces, at most 1,000 characters).
- **Paths.**
  - yt-dlp writes only into the job dir (`-P`). The paths its `DONE` line names must resolve (realpath) to regular files inside it.
  - The download folder is resolved at enqueue (real path, a writable folder outside the data dir; only the default is ever created) and again right before publishing, where it must be the same real path and still a folder; it is never created then. The file name is one sanitized path component.
  - Publishing never overwrites: a hard link or an exclusive create claims the name, never `rename` onto it (ADR-018).
  - Reveal takes the file's path from the job, never from the request.
- **Logs.**
  - Resolve and enrichment logs carry the URL kind, counts, error codes and timings, never URLs, titles or argv.
  - Download logs carry the first 8 characters of job ids, platforms, error codes, counts and timings. Never URLs, titles, paths, argv, `DONE` lines or `ps` output, and never the message of a filesystem or spawn error, which can hold a path (its code instead).
- **Secret links.** SoundCloud secret links (`/s-…`, `secret_token=`) are credentials. They are never logged, and never written into a file: the comment tag holds only a public page URL (ADR-016).
- **Secrets:**
  - Sign-ins are opt-in and per platform. yt-dlp reads browser cookies at runtime, and the app never stores cookies.
  - Secrets never go into argv (visible in `ps`) or logs.
- **Other local users and processes are out of scope** (ADR-001): the server doesn't authenticate local clients. The data dir and its `jobs/` must be owned by the user and are created 0700.
- **Bounds.** A download request holds at most 5,000 items in 8 MiB, with ref texts of at most 1,000 characters. Finished jobs beyond 2,000 are dropped (a running batch keeps all of its own). At most 32 event streams are open, and a stream that falls 16 MiB behind, its largest pending event aside, is cut off.

## Persistence
App data dir: `~/Library/Application Support/DJ Scraper/` on macOS, or `DJS_DATA_DIR`. It and `jobs/` are real directories owned by the user, created 0700, never symlinks (ADR-018).
- **`server.lock`:** held by the running server for its whole life (`O_EXLOCK`, `O_NOFOLLOW`); it records `{ pid, startedAt, port }` for a second server's message.
- **`settings.json`:** Zod-validated and repaired field by field on read: an invalid value costs only that field (it gets its default), unknown keys are ignored, and a file with anything invalid is kept as `settings.json.bad` (written with `O_NOFOLLOW`, so a symlink in its place is never followed). Writes are atomic (a unique `settings.json.<uuid>.tmp`, mode 0600, fsync, rename) and coalesced; the copy in memory is the truth. Leftover temp files are removed at startup.
- **`jobs/<attemptId>/`:** one per attempt: yt-dlp's file and thumbnail, and `finalize/` (`out.<ext>`, `cover.jpg`, `final.<ext>`). Removed after the attempt and swept at startup.
- **`jobs/<attemptId>.part.json`:** `{ partPath, placeholderPath? }`, written before a cross-volume copy to `<folder>/.djs-<attemptId>.part`, so the startup sweep can remove the part (and our empty placeholder) if the server dies mid-copy. It stays when the part's folder is gone with the part (renamed, a drive unplugged); the sweep keeps such a record while the folder is missing, for up to 30 days.
- **Download archive** (dedupe, Phase 4): a yt-dlp `--download-archive` file in the app data dir.
- **Jobs:** kept in memory for the server session, with at most 2,000 finished ones. Persistent history comes in Phase 4.
- **Default target folder:** `~/Music/DJ Scraper`, created on its first download.

## Engine binaries
- **Lookup order:** `YTDLP_PATH` / `FFMPEG_PATH`, then `PATH` (Homebrew). `/api/health` reports what it found.
  - A set override never falls back to `PATH`, so a broken override shows up as an error instead of being silently ignored.
  - ffprobe is looked up beside an `FFMPEG_PATH` binary, as yt-dlp's `--ffmpeg-location` does.
  - The PATH search uses only absolute entries and regular, executable files, and spawns nothing.
  - Downloads locate the three tools the same way (`locateEngine`) on every request and every attempt, without running them, so installing one needs no restart. `--ffmpeg-location` is passed to yt-dlp only when `FFMPEG_PATH` is set.
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
| Unit | Vitest | shared helpers and schemas, argv builders, parsers (`-J`, download lines, ffprobe JSON), error mapping, the finalize plan and ID3 writer, folders and publish (with scripted filesystem errors), gates and token bucket, queue state machine, settings store, hooks/components | never |
| Integration | Vitest | real server and processes against the fake engine (`test/fake-yt-dlp.mjs` and `test/fake-ffmpeg.mjs` replaying fixtures, `test/fake-tool.sh` for version probes): spawn, boot, the data-dir lock and sweep, resolve, enrichment, abort, errors, and downloads end to end (below) | never |
| Opt-in | Vitest, `DJS_TEST_REAL_FFMPEG=1` / `DJS_TEST_EXFAT=1` | `test/finalize-real-ffmpeg.test.ts`: finalize against the real ffmpeg 8 on generated audio (our COMM and cover read back from MP3 and AIFF, copies bit-identical, a truncated WebM refused). `test/move-exfat.test.ts`: publishing onto an exFAT disk image it mounts with `hdiutil` | never |
| E2E | Playwright (Chromium, WebKit) | UI flows against the production server + fake engine (`apps/server/test/e2e-server.ts`) | never |
| Smoke | `pnpm smoke ['<url>' …] [--mode …] [--entries N] [--json]`; `pnpm smoke --download [--format f]… [--keep] [--bare] ['<url>' …]` | the real resolver against live YouTube/SoundCloud; with `--download`, the real download pipeline into a fresh temp dir, each file read back with ffprobe and the test ID3 reader. With no URL, the sample set from the `smoke-test` skill (its two shortest tracks with `--download`) | yes, run by hand |

Downloads integration tests:
- `test/downloads-app.ts` is the harness: the real app (`startServer` + `createApp`) with the real queue, attempt, finalize, publish, gates, bus, event streams and settings (`createServices`, as the server builds them), against the fake engine, with no download buckets and short cooldowns. `test/services.test.ts` checks the production wiring itself: one SoundCloud budget for lookups and downloads. It reads the SSE stream like a browser. Its `stop()` runs the real shutdown, and fails the test on any event off the contract or any log line holding a URL, a path, or a title or artist from the fixtures.
- `test/downloads.test.ts` covers a mixed batch (file names, COMM and APIC read back with `test/id3-reader.ts`, `jobs/` empty afterwards), cancel (queued, downloading, inside yt-dlp's postprocessing, inside our ffmpeg pass), retry, an existing file (skipped, the user's file byte-identical), rate limits and a persistent bot check, previews, reconnecting to a fresh snapshot, a folder renamed before publishing, and bulk actions as one event.
- `test/lifecycle.test.ts` boots the real entry (`test/entry.ts`): shutdown with a hanging download and an open stream, the boot sweep of a leftover process group and part file, and a second server on the same data dir (it waits 9 s, then exits 1).
- Every spawned server entry gets its own `DJS_DATA_DIR` and `HOME` (`serverEnv` in `test/helpers.ts`; servers that must share a data dir share one), so no test touches the user's data dir or `~/Music`.
- `test/smoke-download.test.ts` runs the smoke script's download path offline against the fake engine.

E2E (`pnpm test:e2e` = `playwright test` in `apps/web`; `pnpm test:e2e:install` downloads Chromium's headless shell and WebKit once):
- Playwright's `webServer` first builds the UI into its own `node_modules/.e2e-dist`, never `dist`, which `pnpm start` may be serving. It then runs `apps/server/test/e2e-server.ts` on that build, on port 4849, so e2e can run beside `pnpm dev` and `pnpm start`.
- That script serves the freshly built UI in production mode with a healthy fake engine: a temp PATH of fake yt-dlp, ffmpeg and ffprobe (symlinks to `fake-tool.sh`), with node as the JS runtime, and its own data dir and home folder. It keeps the server child in its own process group, so Playwright's signals reach it, and it removes its temp dir on exit.
- Specs import `test` and `expect` from `e2e/fixtures.ts`, whose console guard fails a test on any console error, warning or page error. That includes the browser's own "Failed to load resource" lines, e.g. for `/api/events` while the server is down.
- They cover what jsdom can't: the focus ring actually drawing, the popover fitting a 420 px window, and reduced motion. WebKit stands in for Safari. Its Tab skips links, so keyboard tests use Option-Tab there.
- The cached Firefox build is too old for Playwright 1.63, so Firefox isn't a project.

Web tests (`apps/web`) run in jsdom with Testing Library. They fake `fetch` at the network edge (`src/test/fake-api.ts`) instead of mocking hooks, use a fresh QueryClient per test, and fail on any `console.error` or `console.warn` (React warnings included). The event stream tests drive `FakeEventSource` (`src/test/fake-event-source.ts`) with fake timers and a stubbed `document.visibilityState`, and check that `stop()` leaves no timer behind. Node-side files at the package root (`dev-guard.test.ts`, `dev-exit.test.ts`, `vite-config.test.ts`) choose the node environment per file.

Fixtures:
- **Where:** `apps/server/test/fixtures/youtube/` and `soundcloud/` (`-J` output), `errors/` (stderr), `engine/` (version probe output), `downloads/` (a stdout + stderr pair per download run with the real download argv) and `ffprobe/` (ffprobe JSON of real downloads and of finalize's outputs).
- **Recording:** each is recorded from a real run. `-J` dumps are piped through `fixtures/trim.mjs`, which trims bulk and scrubs signed stream URLs and IPs; stderr logs are kept verbatim. Download logs replace the job dir with `{JOBDIR}`, and synthetic ones may use `{NOW+<sec>}` for a time the fake fills in. The tool version and date are noted in the directory's `README.md`. The checklist for a new case is the Fixtures rule in `apps/server/CLAUDE.md`.
- **Synthetic logs:** error logs that can't be produced on demand (429, bot check, geo block) are synthetic, built from upstream wording, and marked as such.
- **Meta-tests:** a fixture without its test entry fails. `-J` dumps need a `RECORDED_URLS` entry (`ytdlp-parse.test.ts`), stderr logs a `FIXTURES` entry (`ytdlp-errors.test.ts`), download cases a `DOWNLOAD_FIXTURES` row (`ytdlp-progress.test.ts`) and a `DOWNLOAD_FAILURES` or `DOWNLOAD_SUCCESSES` entry (`ytdlp-errors.test.ts`), and ffprobe files a `PROBES` entry (`finalize-plan.test.ts`). Every recording also needs a rule in `fake-yt-dlp.json` or a `WITHOUT_RULES` reason (`test/fake-yt-dlp.test.ts`).

Fake engine:
- **Fake binaries:** they are checked in with their exec bit and symlinked per test, because endpoint security scans each newly written executable on its first run. `test/fake-tool.sh` stands in for the version probes.
- **`test/fake-yt-dlp.mjs`:** it replays the fixtures through the manifest `fixtures/fake-yt-dlp.json`, matching by URL and flags.
  - For `-J` calls it matches the playlist flag and applies `-I` to recorded lists.
  - A download call (`-P` and the `DONE` print) replays a `downloads/` case: the recorded lines in order, and the files the run left (the thumbnail before `START`, a `.part` while downloading, a fake audio file once finished), with `{JOBDIR}` and `{NOW+n}` filled in.
  - It exits 2 on argv that breaks our rules (no `--ignore-config`, no `--`, or a download argv without its required flags).
  - Env knobs add a delay, a hang until SIGINT, a shorter forced wait, extra rules, or a calls log.
- **`test/fake-ffmpeg.mjs`:** one script that is ffprobe or ffmpeg by the name of its link. Its media are FAKEAUDIO files (`test/fake-media.mjs`): ffmpeg writes them as its argv says (an AIFF inside a real FORM container), and ffprobe answers with the recorded `ffprobe/` JSON the file's header names. It exits 2 on argv finalize never builds, and otherwise answers like ffmpeg 8 (exit 0 on an existing output, 234 for a cover a container can't hold, `-vn` dropping a mapped cover). Knobs make a pass fail, hang, come out short or lose its tags. It doesn't read ID3 tags; tests read those with `test/id3-reader.ts`.
- Point the engine at them with `writeFakeYtdlp`, `writeFakeFfmpeg` or `writeFakeEngine` in `test/helpers.ts` (`YTDLP_PATH`, `FFMPEG_PATH`). `test/e2e-server.ts` still uses `fake-tool.sh`, which answers only `--version`.
