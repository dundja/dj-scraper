# Roadmap

Work top to bottom. Tick items (`- [x]`) as they land and add discovered work as new unchecked items in the right phase. A SessionStart hook shows the current phase and its next open items to every new Claude session.

## Phase 0 — Scaffold
Done when `pnpm dev` shows the app shell with live engine status, and `pnpm check && pnpm typecheck && pnpm test` pass.

- [x] Root workspace: `package.json` (scripts: dev, build, start, check, check:fix, typecheck, test, test:e2e, smoke), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict), `biome.json`, pinned `packageManager` and Node engine
- [x] `packages/shared`: Zod + first schemas (Platform, Track, Collection, ResolveResult, ErrorCode), consumed as TS source
- [x] `apps/server`: Hono on `127.0.0.1:4747`, Host/Origin guard, `GET /api/health` (yt-dlp/ffmpeg/ffprobe found? versions? JS runtime?), watch mode for dev; add `forbidden` and `not_found` error codes for the guard and unknown routes
- [x] `apps/web`: Vite + React + TanStack Router (file routes) + Query + Tailwind v4 + shadcn/ui (Base UI, Nova: ADR-010); dark app shell showing engine status from `/api/health`. Vite dev server: `strictPort`, `cors: false`, anti-framing headers, the Fetch Metadata dev guard, and an `/api` proxy that keeps the browser's Host (ADR-011); ports from `@dj-scraper/shared`. The API client sends `Content-Type: application/json` on every non-GET
- [x] `pnpm dev` runs both with the `/api` proxy (done with the `apps/web` item)
- [ ] `pnpm start` serves the built SPA from the server: static files and the SPA fallback behind the guard, the same anti-framing headers as the dev server, and the browser opened on start. The "Server offline" and "Unexpected response" texts say `pnpm dev`; make them fit `pnpm start` too
- [x] Vitest across packages (web: Testing Library + jsdom, done with the `apps/web` item)
- [ ] Playwright with one e2e (shell loads, health is OK). Also cover what jsdom can't: the focus ring, popover placement in the viewport, reduced motion
- [ ] Ctrl-C on `pnpm dev` stops both processes but ends with `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, because Vite dies by SIGINT. Make Vite exit 0 on SIGINT
- [ ] Update `CLAUDE.md` (commands, layout) to match what was built

## Phase 1 — Engine & resolve
Done when `pnpm smoke <url>` prints a normalized result for YouTube and SoundCloud tracks and playlists, and the parsers are covered by fixture tests.

- [x] Binary discovery (`YTDLP_PATH`/`FFMPEG_PATH` → `PATH`), versions, JS runtime check, warning when yt-dlp is more than ~60 days old (done with the `apps/server` item)
- [ ] `classifyUrl` in shared (YouTube watch/shorts/youtu.be/music/playlist/mix/channel; SoundCloud track/set/user/likes/secret links; other) + tests
- [x] `engine/run.ts`: the one spawn wrapper (argv only, detached process group, line streaming on stdout and stderr, abort, timeout) (done with the `apps/server` item)
- [ ] Resolve: `yt-dlp -J --flat-playlist` → normalized Track/Collection for YouTube and SoundCloud; record fixtures (include a SoundCloud user page that mixes in sets: keep only track rows)
- [ ] SoundCloud set entries are bare (id + url): `POST /api/resolve/entries` with lazy, throttled per-track enrichment. The response needs a per-id failure shape (removed track, 429), not a bare `Track[]`
- [ ] Map yt-dlp errors to `ErrorCode` (unavailable, private, geo-blocked, age-restricted, bot check, rate-limited, unsupported, …) with fixtures
- [ ] `POST /api/resolve`, including the ambiguous `watch?v=…&list=…` case and capped mixes, plus the `pnpm smoke <url>` script. Input URLs: http(s), length cap, no embedded credentials (argv shows in `ps`). Add a `readJson(c, Schema)` helper: malformed JSON or a failed Zod check → 400 `invalid_request`. This is the web client's first request body, so test `lib/api.ts`'s JSON body path with it
- [ ] Collection header data: the platform's track count and SoundCloud's set duration when yt-dlp reports them, and `truncated` when our `-I` cap cut the list. Reconcile the 1000-entry cap with "smooth with 1,000+ tracks" (product.md)
- [ ] `test/fake-yt-dlp.mjs` that replays fixtures for integration and e2e tests. Check it in with its exec bit and symlink it per test (like `test/fake-tool.sh`): endpoint security scans every newly written executable on first run, which made per-test scripts time out
- [ ] `.gitignore` ignores `*.log`, which would drop the planned `<case>.log` fixtures: un-ignore `apps/server/test/fixtures/**/*.log`

## Phase 2 — Download pipeline
Done when the API downloads a selected set of tracks into a folder with live progress, cancel and retry, all tested against the fake engine.

- [ ] Download argv builder per format (MP3 320 CBR default, M4A copy, WAV, FLAC, original); yt-dlp writes only into a per-job temp dir
- [ ] Parse progress (`DL`/`PP` lines, fragments for HLS, enforced "waiting" sleeps) and the final `DONE` JSON
- [ ] Finalize: artist/title, tags (comment = source URL), AIFF + artwork via ffmpeg, filename template, sanitize, skip-if-exists, safe move (copy + unlink across volumes)
- [ ] Job queue: concurrency limit, state machine, cancel (SIGINT to the process group → SIGKILL → delete job dir), retry, stale job dirs swept at startup. Shutdown aborts and awaits every run before closing. Engine groups survive a SIGKILLed server, so record each job's pgid and kill leftover groups at startup
- [ ] Per-platform pacing and back-off (YouTube ~300 tracks/h without login, SoundCloud 429s); Go+ previews reported as `preview_only`
- [ ] `GET /api/events` (SSE with heartbeat, throttled progress), `POST /api/downloads`, cancel, retry, reveal. A dropped SSE connection should also flip the engine chip to "Server offline": today it only notices on the next health request. Define `TrackRef` so a partial (not yet enriched) row can be downloaded
- [ ] Settings store in the app data dir + `GET/PUT /api/settings`; native folder picker `POST /api/folders/pick`

## Phase 3 — UI
Done when the full flow works in the browser: paste → (track: auto-download | playlist: select → download) → progress → files in Finder.

- [ ] Paste anywhere / drop / type; instant platform + type badge; resolve on paste
- [ ] Track card with immediate download and cancel
- [ ] Collection view: header, virtualized track table, select all/none/invert, shift-click ranges, filter, unavailable rows disabled, progressive fill-in for SoundCloud sets
- [ ] Download bar: target folder (header picker + recents), format, playlist-subfolder toggle, "Download N tracks"
- [ ] Downloads panel: per-track and overall progress, waiting state, cancel/retry, reveal in Finder
- [ ] "This track or the whole playlist?" prompt for watch+list URLs
- [ ] Engine missing/outdated banner and friendly error states
- [ ] Playwright e2e for both flows against the fake engine

## Phase 4 — DJ polish
- [ ] Settings page (format, filename template, artwork, concurrency, auto-download singles, sign-ins)
- [ ] Artist/title clean-up rules ("Official Video", "[HD]", "Lyrics", …) with preview
- [ ] Already-downloaded detection (download archive) with badges in the track list
- [ ] Persistent download history
- [ ] Optional sign-ins, per platform and opt-in: browser cookies for age-restricted YouTube, SoundCloud login for originals and Go+ (never passed in argv)
- [ ] Keyboard shortcuts (paste, select all, download, cancel)

## Phase 5 — Distribution (optional)
- [ ] App-managed yt-dlp (pinned, unpacked `yt-dlp_macos.zip` build; the app downloads stable/nightly updates itself, since that build can't use `-U`) and ffmpeg/ffprobe
- [ ] Desktop wrapper (Tauri or Electron) and Windows support

## Ideas (unscheduled)
BPM/key detection · Rekordbox XML / M3U export · square-crop 16:9 YouTube artwork · Spotify playlist → match tracks on YouTube/SoundCloud · first-class Bandcamp and Mixcloud
