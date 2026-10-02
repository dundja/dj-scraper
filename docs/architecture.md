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
| prod | `pnpm start` | `pnpm build` (the web app), then the server on `127.0.0.1:4747` (`node src/index.ts --open`), serving the built SPA and `/api`, and opening it in the default browser |

The server runs its TypeScript source directly on Node, with no build step (ADR-009). Config comes from env, validated with Zod at boot (`config.ts`):
- `PORT`: default 4747, allowed 1024–65535. Browsers drop default ports such as 80 from `Host`, which the guard would then reject. The rule is `PortSchema` in `packages/shared`, and the Vite proxy reads `PORT` with it too, so `PORT=… pnpm dev` moves both ends.
- `YTDLP_PATH`: an absolute path to the yt-dlp binary.
- `FFMPEG_PATH`: an absolute path to the ffmpeg binary, or to a directory holding ffmpeg and ffprobe, as with `--ffmpeg-location`.
- `DJS_WEB_DIST`: an absolute path to the built UI. The default is `apps/web/dist`, found from the server's source location rather than the cwd (ADR-009). Tests and the e2e server set it.
- `DJS_DATA_DIR` (planned), which overrides the app data dir (tests use it).
- An empty variable counts as unset.
- Flags:
  - `--dev` (set by `pnpm dev`) also trusts the Vite dev server on port 5173 (see Security model). The server then serves no UI, because Vite does.
  - `--open` (set by `pnpm start`) opens `http://127.0.0.1:<port>/` once listening. On macOS that runs `/usr/bin/open <url>` through `engine/run.ts`; elsewhere it logs the URL. A failure only warns. It is ignored with `--dev`.
- Outside `--dev`, a missing `index.html` in the web dist prints one warning at boot. The API keeps working, and pages answer 404 `not_found` saying to run `pnpm build`.

## Workspace & tooling
The reasons are in ADR-007.
- **Scripts.** Each root script delegates to the package scripts of the same name.
  - `dev`, `build`, `typecheck` and `test` run in every package that defines them (`pnpm -r --if-present run …`). `build` runs in dependency order, but only `apps/web` defines it so far (ADR-009).
  - `start` first runs `pnpm build`, so it never serves a stale UI, then the server's `start` (`node src/index.ts --open`). `smoke` runs in `@dj-scraper/server`, and `test:e2e` runs in `@dj-scraper/web`. Each fails if its package doesn't exist.
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
  - Three tsconfigs, all checked by `typecheck`:
    - `tsconfig.json` for `src`: `module: preserve`, so bundler resolution, plus the `@/*` → `src/*` alias shadcn/ui expects.
    - `tsconfig.node.json` for the Node-side files: the Vite and Vitest configs and the dev-server plugins.
    - `tsconfig.e2e.json` for `playwright.config.ts` and `e2e/`: Node types plus the DOM lib, because `page.evaluate` callbacks run in the browser.
  - Our own imports keep the extension, also through the alias (`@/lib/api.ts`). Generated shadcn/ui files don't.
  - TanStack Router's Vite plugin writes `src/routeTree.gen.ts` on `dev` and `build`. It is committed, because `tsc` needs it, and its temp dir `.tanstack/` is ignored.
  - Vitest has its own `vitest.config.ts` without the router and Tailwind plugins, so test runs never rewrite the route tree.
  - `pnpm build` makes one ~570 kB bundle (react-dom, zod, Base UI, TanStack). It loads from localhost, so there is no vendor splitting, and the chunk-size warning starts at 1 MB.

## Server modules (`apps/server/src`)
Rows marked *Phase 2* don't exist yet.

| Module | Responsibility |
|---|---|
| `index.ts` | boot, engine check at startup (logs shared `healthProblems`), graceful shutdown (kill engine process groups; cancel jobs once they exist) |
| `config.ts` | env + `--dev`/`--open` → `Config`, Zod-validated |
| `startup.ts` | after listening: the missing-UI warning and `--open` |
| `server.ts` | `startServer`: `node:http` + Hono's request listener on `127.0.0.1`; listen errors reject; `close()` also drops open connections |
| `app.ts` | Hono app, in this order: security headers, guard, `/api` routes, the built UI (not with `--dev`), `notFound` and `onError` |
| `http/security-headers.ts` | anti-framing, `nosniff` and `no-referrer` headers on every response (see Security model) |
| `http/guard.ts` | Host/Origin/Fetch-Metadata guard and JSON-only mutations; with `--dev` it also trusts the Vite port (see Security model) |
| `http/errors.ts` | `ApiError`, the `ErrorCode` → HTTP status map, error and 404 handlers |
| `http/json.ts` | `readJson(c, Schema)` (malformed JSON or a failed Zod check → 400 `invalid_request`) and the 64 KiB body limit for JSON routes |
| `routes/*` | thin HTTP layer: validate with shared schemas → call a service → respond. `system.ts` (health, recheck) and `resolve.ts` (resolve, entries) so far, plus `web.ts` (next row) |
| `routes/web.ts` | serves the built UI and the SPA fallback (see Security model) |
| `engine/binaries.ts` | locate yt-dlp/ffmpeg/ffprobe and a JS runtime, probe their versions → `Health` |
| `engine/versions.ts` | pure: version output → version, release date, major, checked against the minimums from `@dj-scraper/shared` |
| `engine/health.ts` | cached health check (10 min, one probe at a time) |
| `engine/run.ts` | the **only** place that spawns processes: argv only, detached process group, line streaming, abort, timeout |
| `engine/ytdlp-args.ts` | pure: (url, options) → argv; the base argv every call shares |
| `engine/ytdlp-parse.ts` | pure: info JSON → Track/Collection, read with tolerant schemas and checked against the contract. `DL`/`PP`/`DONE` progress parsing joins it in Phase 2 |
| `engine/ytdlp-errors.ts` | pure: yt-dlp stderr + exit code → `ErrorInfo` with a human message, from an ordered pattern table backed by fixtures |
| `engine/finalize.ts` | *Phase 2.* After yt-dlp: artist/title + filename (pure), tags and AIFF via ffmpeg, safe move into the target folder |
| `resolve/plan.ts` | pure: classified URL + mode → what to ask yt-dlp (URL, playlist flag, entry cap, timeout, `ambiguous` wrapping) |
| `resolve/resolver.ts` | `POST /api/resolve`: plan → one yt-dlp call → normalize → contract check; at most 4 at a time |
| `resolve/enricher.ts` | `POST /api/resolve/entries`: per-row lookups with per-platform pacing, SoundCloud's request budget, rate-limit cooldown and a 30 min cache |
| `resolve/limiter.ts`, `lru.ts`, `input.ts`, `ytdlp-call.ts` | FIFO limiter (concurrency, min gap between starts, optional token-bucket budget, abortable waits, a bypass for answers from cache), TTL/LRU cache, URL checks shared by both services, one yt-dlp call → JSON or `ErrorInfo` |
| `jobs/queue.ts` | *Phase 2.* Download queue: concurrency, per-platform pacing/back-off, state machine, cancel/retry |
| `jobs/bus.ts` | *Phase 2.* Typed event emitter feeding SSE |
| `settings/` | *Phase 2.* Load/save settings JSON (Zod-validated, defaults filled on read) |
| `fs/` | *Phase 2.* Native folder picker (macOS `osascript` "choose folder"), path safety, filename sanitizing |

## Web modules (`apps/web`)
| Module | Responsibility |
|---|---|
| `vite.config.ts` | dev server (port 5173, `strictPort`, `cors: false`, anti-framing headers, `/api` proxy keeping the browser's Host), router/React/Tailwind plugins |
| `dev-guard.ts` | dev-server plugin: the guard's exact Host check and Fetch Metadata rule for every request Vite answers; `/__open-in-editor` only from the page itself |
| `dev-exit.ts` | dev-server plugin: Ctrl-C (SIGINT) or SIGTERM closes Vite and exits 0, so `pnpm dev` ends cleanly (Vite alone dies by SIGINT and exits 143 on SIGTERM) |
| `playwright.config.ts`, `e2e/` | Playwright e2e against `apps/server/test/e2e-server.ts` (see Testing) |
| `src/main.tsx` | mounts the app: QueryClient, router with `{ queryClient }` context |
| `src/routes/__root.tsx` | the shell: header (app name, engine status), `<Outlet/>`, not-found page |
| `src/routes/index.tsx` | home: the paste flow (Phase 3); an empty state for now |
| `src/lib/api.ts` | the only `fetch` caller: same-origin `/api`, JSON `Content-Type` on every non-GET, shared-schema validation, `ApiError` (`api` / `unreachable` / `invalid_response`) |
| `src/features/engine/` | `useHealth` (query `['health']`, retried every 3 s only while failing) and `useRecheckHealth`; the header chip and popover (`EngineStatus`) listing tools, versions and `healthProblems` |
| `src/components/ui/` | shadcn/ui components (Base UI, Nova), generated by the CLI |
| `src/test/` | test helpers: fake `fetch` at the network edge, Health fixtures, render with a fresh QueryClient, the console guard |

## API (v1)
JSON bodies are validated with the shared schemas. Errors use the shape `{ error: { code: ErrorCode, message } }` (`ApiErrorBody`) with the status from `http/errors.ts`: 400 `invalid_url`/`invalid_request`, 403 `forbidden`, 404 `not_found`, 409 `canceled`, 413 `invalid_request` for a JSON body over 64 KiB, 415 `invalid_request` for a non-JSON mutation, 422 `unsupported_url` and content the platform refuses (`unavailable`, `private`, `geo_blocked`, `age_restricted`, `login_required`, `bot_check`, `preview_only`), 429 `rate_limited`, 502 `network`, 503 `engine_missing`, 500 `postprocess_failed`/`unknown`.

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | – | `Health` (cached up to 10 min): per tool `ok`/`missing`/`error` with path, version and minimum checks, yt-dlp age, JS runtimes, overall `ok` |
| `POST /api/health/recheck` | – | `Health`, probed now (e.g. after installing yt-dlp) |
| `POST /api/resolve` | `ResolveRequest`: `{ url, mode?: 'auto' \| 'track' \| 'collection' }` | `ResolveResult`. Errors: 400 `invalid_url`, 422 `unsupported_url` (DRM services, unsupported sites) and the platform's refusals, 429, 502, 503 `engine_missing` |
| `POST /api/resolve/entries` | `ResolveEntriesRequest`: `{ entries: { platform, id, url }[] }`, 1–25 partial rows | `{ results: EntryResult[] }`, one per distinct platform + id in request order: `{ status: 'ok', platform, id, track }` or `{ status: 'error', platform, id, error }`. A failed row never fails the batch; only a missing yt-dlp fails the request (503) |
| `POST /api/downloads` | `{ items: TrackRef[], folder, options: DownloadOptions }` | `{ batchId, jobs: Job[] }` |
| `GET /api/downloads` | – | `Job[]` for this server session |
| `POST /api/downloads/:id/cancel` | – | `Job` |
| `POST /api/downloads/:id/retry` | – | `Job` |
| `POST /api/downloads/:id/reveal` | – | `204`; reveals the job's output file in Finder |
| `GET /api/events` | – | SSE stream of `ServerEvent` |
| `GET /api/settings`, `PUT /api/settings` | `Settings` | `Settings` |
| `POST /api/folders/pick` | `{ startIn?: string }` | `{ path }` or `{ canceled: true }` |

## Domain model (`packages/shared`)
The schemas in `packages/shared/src` are authoritative. The first block below summarizes them; the second is still a sketch for Phase 2.

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
```

```ts
// Sketch (Phase 2)
// TrackRef: not designed yet. It must let a partial (not yet enriched) row be downloaded.

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
   - `source` is the stream yt-dlp's `ba` would download: the last audio-only format, skipping Go+ previews and SoundCloud's login-only original. A track that only has preview formats is `unavailable` with reason `preview_only`, without a duration.
5. **Enrichment.** The web asks `POST /api/resolve/entries` for the partial rows in view. The server looks each row up with `yt-dlp -J --flat-playlist --no-playlist -- <row url>`:
   - Pacing is per platform: two lookups at a time, with a minimum gap between starts. SoundCloud adds a request budget, a burst of 25 lookups refilling one every 5 s. That is about 120 lookups per 10 min, or 360–600 API requests at the measured 3–5 per lookup, within SoundCloud's ~600.
   - A `rate_limited` row pauses its platform for 60 s, doubling per consecutive hit up to 10 min. During the pause, rows fail at once without spawning.
   - Results are cached for 30 min (2,000 rows), and concurrent requests for the same row share one lookup. That lookup stops only when every request waiting on it is gone. Rows that are lists are refused.
   - Pacing, budget, cooldown and cache are keyed by the platform of the row's URL, not the `platform` the client sent. Results echo the request's platform and id.
   - Timers use a monotonic clock, so a wall-clock jump can't stall pacing or expire the cache.

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
- **Response headers.** Every response the app produces carries `SECURITY_HEADERS` from `packages/shared`: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. That includes pages, assets, API answers, the guard's rejections and errors. The middleware runs before the guard, and the Vite dev server sends the same set.
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
  - Vite binds whatever `localhost` resolves to: `[::1]:5173` on macOS. When the server is down, its proxy answers 502 `text/plain` with an empty body, which the web client reports as "Server offline".
  - `apps/web/vite-config.test.ts` pins every setting above, so dropping one fails a test.
- **Processes.** Argv arrays only (`shell: false`), with `--ignore-config`. The URL is validated by `classifyUrl` (http/https only, at most 2,048 characters, no username or password, since argv shows in `ps`) and passed last, right after `--`. Nothing else in the argv comes from the request.
- **Logs.** SoundCloud secret links (`/s-…`, `secret_token=`) are credentials. Resolve and enrichment logs carry the URL kind, counts, error codes and timings, never URLs, titles or argv.
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
| Integration | Vitest | real server and processes against the fake engine (`test/fake-yt-dlp.mjs` replaying fixtures, `test/fake-tool.sh` for version probes): spawn, boot, resolve, enrichment, abort, errors; downloads (progress, cancel, finalize) in Phase 2 | never |
| E2E | Playwright (Chromium, WebKit) | UI flows against the production server + fake engine (`apps/server/test/e2e-server.ts`) | never |
| Smoke | `pnpm smoke ['<url>' …] [--mode …] [--entries N] [--json]` | the real resolver against live YouTube/SoundCloud; with no URL, the sample set from the `smoke-test` skill | yes, run by hand |

E2E (`pnpm test:e2e` = `playwright test` in `apps/web`; `pnpm test:e2e:install` downloads Chromium's headless shell and WebKit once):
- Playwright's `webServer` first builds the UI into its own `node_modules/.e2e-dist`, never `dist`, which `pnpm start` may be serving. It then runs `apps/server/test/e2e-server.ts` on that build, on port 4849, so e2e can run beside `pnpm dev` and `pnpm start`.
- That script serves the freshly built UI in production mode with a healthy fake engine: a temp PATH of fake yt-dlp, ffmpeg and ffprobe (symlinks to `fake-tool.sh`), with node as the JS runtime. It keeps the server child in its own process group, so Playwright's signals reach it, and it removes its temp dir on exit.
- Specs import `test` and `expect` from `e2e/fixtures.ts`, whose console guard fails a test on any console error, warning or page error.
- They cover what jsdom can't: the focus ring actually drawing, the popover fitting a 420 px window, and reduced motion. WebKit stands in for Safari. Its Tab skips links, so keyboard tests use Option-Tab there.
- The cached Firefox build is too old for Playwright 1.63, so Firefox isn't a project.

Web tests (`apps/web`) run in jsdom with Testing Library. They fake `fetch` at the network edge (`src/test/fake-api.ts`) instead of mocking hooks, use a fresh QueryClient per test, and fail on any `console.error` or `console.warn` (React warnings included). Node-side files at the package root (`dev-guard.test.ts`, `dev-exit.test.ts`, `vite-config.test.ts`) choose the node environment per file.

Fixtures:
- **Where:** `apps/server/test/fixtures/youtube/` and `soundcloud/` (`-J` output), `errors/` (stderr), and `engine/` (version probe output).
- **Recording:** each is recorded from a real run. `-J` dumps are piped through `fixtures/trim.mjs`, which trims bulk and scrubs signed stream URLs and IPs; stderr logs are kept verbatim. The tool version and date are noted in the directory's `README.md`. The checklist for a new case is the Fixtures rule in `apps/server/CLAUDE.md`.
- **Synthetic logs:** error logs that can't be produced on demand (429, bot check, geo block) are synthetic, built from upstream wording, and marked as such.

Fake engine:
- **Fake binaries:** they are checked in and symlinked per test, because endpoint security scans each newly written executable on its first run. `test/fake-tool.sh` stands in for the version probes.
- **`test/fake-yt-dlp.mjs`:** it replays the fixtures through the manifest `fixtures/fake-yt-dlp.json`, matching by URL and playlist flag, and applies `-I` to recorded lists.
  - It exits 2 on argv that breaks our rules (no `--ignore-config`, no `--`).
  - Env knobs add a delay, a hang until SIGINT, extra rules, or a calls log.
  - Point `YTDLP_PATH` at it for integration tests (`writeFakeYtdlp` in `test/helpers.ts`); `test/e2e-server.ts` still uses `fake-tool.sh`, which answers only `--version`.
