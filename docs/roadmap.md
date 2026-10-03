# Roadmap

Work top to bottom. Tick items (`- [x]`) as they land and add discovered work as new unchecked items in the right phase. A SessionStart hook shows the current phase and its next open items to every new Claude session.

## Phase 0 — Scaffold
Done when `pnpm dev` shows the app shell with live engine status, and `pnpm check && pnpm typecheck && pnpm test` pass.

- [x] Root workspace: `package.json` (scripts: dev, build, start, check, check:fix, typecheck, test, test:e2e, smoke), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict), `biome.json`, pinned `packageManager` and Node engine
- [x] `packages/shared`: Zod + first schemas (Platform, Track, Collection, ResolveResult, ErrorCode), consumed as TS source
- [x] `apps/server`: Hono on `127.0.0.1:4747`, Host/Origin guard, `GET /api/health` (yt-dlp/ffmpeg/ffprobe found? versions? JS runtime?), watch mode for dev; add `forbidden` and `not_found` error codes for the guard and unknown routes
- [x] `apps/web`: Vite + React + TanStack Router (file routes) + Query + Tailwind v4 + shadcn/ui (Base UI, Nova: ADR-010); dark app shell showing engine status from `/api/health`. Vite dev server: `strictPort`, `cors: false`, anti-framing headers, the Fetch Metadata dev guard, and an `/api` proxy that keeps the browser's Host (ADR-011); ports from `@dj-scraper/shared`. The API client sends `Content-Type: application/json` on every non-GET
- [x] `pnpm dev` runs both with the `/api` proxy (done with the `apps/web` item)
- [x] `pnpm start` serves the built SPA from the server: static files and the SPA fallback behind the guard (ADR-012), anti-framing, `nosniff` and `no-referrer` headers on every response, and the browser opened on start (`--open`). The offline texts say `pnpm start` in the built app
- [x] Vitest across packages (web: Testing Library + jsdom, done with the `apps/web` item)
- [x] Playwright (Chromium, WebKit) with one e2e spec (shell loads, health is OK, deep link, recheck), plus what jsdom can't test: the focus ring, popover placement in the viewport, reduced motion
- [x] Ctrl-C on `pnpm dev` exits 0: a dev-only Vite plugin (`dev-exit.ts`) closes Vite on SIGINT/SIGTERM. Before, pnpm reported `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` because Vite died by SIGINT
- [x] Update `CLAUDE.md` (commands, layout) to match what was built

## Phase 1 — Engine & resolve
Done when `pnpm smoke <url>` prints a normalized result for YouTube and SoundCloud tracks and playlists, and the parsers are covered by fixture tests.

- [x] Binary discovery (`YTDLP_PATH`/`FFMPEG_PATH` → `PATH`), versions, JS runtime check, warning when yt-dlp is more than ~60 days old (done with the `apps/server` item)
- [x] `classifyUrl` in shared (YouTube watch/shorts/youtu.be/music/playlist/mix/channel; SoundCloud track/set/user/likes/secret links; other) + tests. Also refuses DRM hosts (incl. Amazon Music) and look-alike hosts, adds `https://` to scheme-less links, and flags secret links so they're never logged
- [x] `engine/run.ts`: the one spawn wrapper (argv only, detached process group, line streaming on stdout and stderr, abort, timeout) (done with the `apps/server` item)
- [x] Resolve: `yt-dlp -J --flat-playlist` → normalized Track/Collection for YouTube and SoundCloud; record fixtures (include a SoundCloud user page that mixes in sets: keep only track rows). `engine/ytdlp-parse.ts`; 29 recorded `-J` fixtures (yt-dlp 2026.08.19) scrubbed by `test/fixtures/trim.mjs`; `splitArtistTitle` in shared
- [x] SoundCloud set entries are bare (id + url): `POST /api/resolve/entries` with lazy, throttled per-track enrichment. The response needs a per-id failure shape (removed track, 429), not a bare `Track[]`. Per-platform pacing, SoundCloud token budget, rate-limit cooldown, shared in-flight lookups, 30 min cache (ADR-014)
- [x] Map yt-dlp errors to `ErrorCode` (unavailable, private, geo-blocked, age-restricted, bot check, rate-limited, unsupported, …) with fixtures. `engine/ytdlp-errors.ts`; 36 stderr fixtures, synthetic ones marked with their upstream source
- [x] `POST /api/resolve`, including the ambiguous `watch?v=…&list=…` case and capped mixes, plus the `pnpm smoke <url>` script. Input URLs: http(s), length cap, no embedded credentials (argv shows in `ps`). Add a `readJson(c, Schema)` helper: malformed JSON or a failed Zod check → 400 `invalid_request`. `ambiguous` carries `collectionKind`; channel roots → `/videos`; `playlist?list=RD…` → seeded watch URL; embed player lists → playlist page (ADR-013). The web-client half (test `lib/api.ts`'s JSON body path with this route) is the item below
- [x] Collection header data: the platform's track count and SoundCloud's set duration when yt-dlp reports them, and `truncated` when our `-I` cap cut the list. Reconcile the 1000-entry cap with "smooth with 1,000+ tracks" (product.md). Cap is 5,000 (mixes 50), asked as `-I 1:<cap+1>`; `skippedEntries` counts non-track rows (ADR-013)
- [x] `test/fake-yt-dlp.mjs` that replays fixtures for integration tests (`writeFakeYtdlp` in `test/helpers.ts`). Check it in with its exec bit and symlink it per test (like `test/fake-tool.sh`): endpoint security scans every newly written executable on first run, which made per-test scripts time out. Manifest `test/fixtures/fake-yt-dlp.json`, `-I` slicing, delay/hang/calls-log knobs, strict argv checks. `test/e2e-server.ts` still uses `fake-tool.sh`, which answers only `--version`
- [x] `.gitignore` ignores `*.log`, which would drop the planned `<case>.log` fixtures: un-ignore `apps/server/test/fixtures/**/*.log`
- [x] Test the web client's JSON body path (`lib/api.ts`) against `POST /api/resolve`: it is the client's first request body
- [x] Decide whether SoundCloud sets with `album_type: album` (see `fixtures/soundcloud/album-set.json`) get kind `album` instead of `set`. Yes: a set whose `album_type` is album, ep, single or compilation is kind `album`, whatever URL it came from, and playlists stay `set` (ADR-013)
- [x] Collection `owner` is missing for SoundCloud user pages (yt-dlp gives only a title like "X (All)") and YouTube Music albums (null uploader): derive it. User pages take the username from the `<username> (<Resource>)` title, and albums the artist of the `<artist> - Topic` channel all their rows share; several artists leave it unset (ADR-013)

## Phase 2 — Download pipeline
Done when the API downloads a selected set of tracks into a folder with live progress, cancel and retry, all tested against the fake engine.

- [x] Download argv builder per format (MP3 320 CBR default, M4A copy, WAV, FLAC, original); yt-dlp writes only into a per-job temp dir. `downloadArgs` in `engine/ytdlp-args.ts`: yt-dlp only downloads the selected stream (no `-x`) into `<dataDir>/jobs/<attemptId>`, and finalize converts (ADR-015). Selectors: YouTube `ba`, SoundCloud `ba[acodec!=opus]/ba`, other `ba/b`; M4A tries `ba[ext=m4a]` first.
  - SoundCloud format narrowing: none. Default formats, and resolve's `audioSource` skips SoundCloud's Opus like the selector, so the source shown is the one downloaded (ADR-017, settling ADR-014).
  - `--extractor-retries 0` for SoundCloud, not `1`, which still retries once (from yt-dlp's source). Retries are bounded (`--retries 3 --fragment-retries 3`), and `--abort-on-unavailable-fragments` stops HLS from skipping a failed fragment silently
- [x] Parse progress (`DL`/`PP` lines, fragments for HLS, enforced "waiting" sleeps) and the final `DONE` JSON. `engine/ytdlp-progress.ts`: the percent comes from fragments first (HLS byte estimates jumped 4.3 % → 0.08 % → 29.8 % live) and never goes back within an attempt; a `before_dl` `START` print gives `available_at` → `progress.waitingUntil`, since quiet mode prints nothing while yt-dlp waits; a `START` with `playlist_id` or a second `START` stops the run as a list. 20 recorded cases in `fixtures/downloads/` (yt-dlp 2026.08.19), each with a meta-tested summary row
- [x] Extend `test/fake-yt-dlp.mjs` to replay downloads (`DL`/`PP`/`DONE` lines, a file in the job dir); the download error logs are already recorded in `fixtures/errors/` (ffmpeg-missing, postprocess-*, interrupted). Download rules (`download: '<case>'`) with `{JOBDIR}`/`{NOW+n}` placeholders and a strict download-argv check; the old `-x` logs keep a `WITHOUT_RULES` reason. Plus `test/fake-ffmpeg.mjs` (fake ffmpeg/ffprobe over the FAKEAUDIO files of `test/fake-media.mjs`, replaying `fixtures/ffprobe/`) and `writeFakeEngine`
- [x] Finalize: artist/title, tags (comment = source URL), AIFF + artwork via ffmpeg, filename template, sanitize, skip-if-exists, safe move (copy + unlink across volumes). `engine/finalize-plan.ts` (pure: tags, comment rule, codec plan, argv, readback checks), `engine/finalize.ts`, `engine/id3.ts` (our ID3v2.3 writer, since ffmpeg 8 can't write COMM), `filename.ts` in shared (180 UTF-16 units), `fs/folders.ts` and `fs/move.ts` (link, or copy + reservation; never `rename` onto a name). Every output is read back with ffprobe, because ffmpeg exits 0 on truncated input (ADR-015, ADR-016, ADR-018)
- [x] Job queue: concurrency limit, state machine, cancel (SIGINT to the process group → SIGKILL → delete job dir), retry, stale job dirs swept at startup. Shutdown aborts and awaits every run before closing. Engine groups survive a SIGKILLed server, so record each job's pgid and kill leftover groups at startup. `jobs/queue.ts`, `jobs/attempt.ts`, `jobs/bus.ts`, `shutdown.ts`: SIGKILL after 3 s, `cancelRequested` while a running job stops, bulk cancel/retry/clear as one event, at most 2,000 finished jobs kept. Instead of pgid records, `server.lock` (`O_EXLOCK`; a second server waits 9 s, then exits 1) makes a `ps` sweep for groups whose argv names `<dataDir>/jobs/<uuid>` safe, and `run.ts` now SIGKILLs every run's group at close (ADR-018)
- [x] Per-platform pacing and back-off (YouTube ~300 tracks/h without login, SoundCloud 429s); Go+ previews reported as `preview_only`. `pacing/gates.ts` and `pacing/token-bucket.ts` (the limiter's bucket, now shareable): YouTube 10 + one per 12 s; SoundCloud shares the enricher's bucket and leaves it 5 tokens; a cooldown of 60 s doubling to 10 min with strikes, a half-open restart and a requeue to the front; 3 own strikes fail a job (ADR-017).
  - YouTube pauses on `bot_check` too, and a bot check that reaches the 10-min cooldown twice in a row fails every queued YouTube job.
  - A ref marked `preview_only` (or any unavailable reason) fails at enqueue without a spawn; SoundCloud downloads also pass `--break-match-filters "format_id!*=preview"`, whose silent exit 101 maps to `preview_only`.
  - `resolve/limiter.ts` is reused for its token bucket only: the queue's gates need cooldowns and strikes the limiter doesn't have.
- [x] `GET /api/events` (SSE with heartbeat, throttled progress), `POST /api/downloads`, cancel, retry, reveal. A dropped SSE connection should also flip the engine chip to "Server offline": today it only notices on the next health request. Define `TrackRef` so a partial (not yet enriched) row can be downloaded. `routes/events.ts` (`retry: 1000`, snapshot first, a typed heartbeat every 15 s, no throttle since `--progress-delta 0.5` already caps progress lines), `routes/downloads.ts` (plus bulk routes and `GET /api/downloads` for tests), `TrackRef` with only platform, id and url required. Web: typed client calls, `lib/events.ts` feeding `['downloads']`, a drop past 2 s rechecks health, and the Vite proxy now ends a response the server cut off (ADR-019)
- [x] Settings store in the app data dir + `GET/PUT /api/settings`; native folder picker `POST /api/folders/pick`. `settings/store.ts` (field-wise repair, the bad file kept as `settings.json.bad`, atomic coalesced writes; a concurrency change resizes the queue), `fs/folder-picker.ts` (osascript `choose folder`, one at a time, 300 s), `fs/reveal.ts` (`open -R`)
- [x] `pnpm smoke --download [--format f]… [--keep] [--bare]`: the real pipeline against live YouTube and SoundCloud into a temp dir, each file read back with ffprobe and `test/id3-reader.ts`; `test/smoke-download.test.ts` runs it offline. The 2026-10-03 run matched the design for every case (YouTube to MP3, M4A, AIFF, original; a SoundCloud MP3 copied at 128 kbps without a comment; Go+ refused)

## Phase 3 — UI
Done when the full flow works in the browser: paste → (track: auto-download | playlist: select → download) → progress → files in Finder.

- [ ] Paste anywhere / drop / type; instant platform + type badge; resolve on paste
- [ ] Track card with immediate download and cancel
- [ ] Collection view: header, virtualized track table, select all/none/invert, shift-click ranges, filter, unavailable rows disabled, progressive fill-in for SoundCloud sets
- [ ] Download bar: target folder (header picker + recents), format, playlist-subfolder toggle, "Download N tracks"
  - Consider reading the picked folder right after a pick, so a macOS privacy prompt appears then rather than in the middle of a batch.
- [ ] Downloads panel: per-track and overall progress, waiting state, cancel/retry, reveal in Finder
  - Read `['downloads']` with `useQuery(downloadsQueryOptions)` only. Never prefetch, `ensureQueryData` or refetch it (its query function is `skipToken`), and never write mutation answers into it: the event stream is its only writer (ADR-019).
  - The `createDownloads` mutation must invalidate `['settings']` on success: the server adds the folder to `recentFolders`.
  - Don't wait for a 100 % progress event: a short track sends one `job.progress` (0.4–0.6 % live) and then switches to processing.
  - `Job.track.artist` can be empty while the file's name and tags use the uploader (a YouTube video without artist metadata).
  - Show `output` (codec, bitrate, copied or encoded) next to `source`: an "MP3" job can be 128 kbps. Show a platform's `pausedUntil` and `nextStartAt` from `queue`, and a requeued job's `lastError`.
- [ ] "This track or the whole playlist?" prompt for watch+list URLs. Word it by `collectionKind`, and default to the track for a mix ("Load the mix (first 50)"). If the track lookup fails (private, age-restricted…), still offer the list with `mode: 'collection'`
- [ ] Loading state for big lists: a 1,788-video channel took 21 s and 5,001 rows up to 56 s. If that proves annoying, stream rows with `--lazy-playlist -j` (ADR-013)
- [ ] SoundCloud `/sets` and `/albums` user tabs resolve to empty collections (only `skippedEntries`): let the user open those sets
- [ ] Partial rows: request enrichment for the rows in view, cancel requests for rows scrolled away, and show placeholders while SoundCloud's budget paces a long scroll
- [ ] Engine missing/outdated banner and friendly error states
- [ ] Playwright e2e for both flows against the fake engine
  - Switch `test/e2e-server.ts` to `writeFakeYtdlp` (with `FAKE_YTDLP_VERSION` set to today's version, see `todaysYtdlpVersion` in `test/helpers.ts`) so e2e can resolve, or to `writeFakeEngine` so it can also download.
  - The console guard in `e2e/fixtures.ts` fails on the browser's own "Failed to load resource" lines (a 404, or Vite's 502 while the server is down, e.g. for `/api/events`). A spec that takes the server down must expect them explicitly instead of muting the guard.
- [x] Export the shared test helpers (`testUuid`, `youtubeRef`, `soundcloudRowRef`, `testBatch`, `jobsByStatus` in `src/test-helpers.ts`) as a package subpath. Done in Phase 2's review fixes: `@dj-scraper/shared/test-helpers`, used by the server and web tests; a Biome `noRestrictedImports` rule keeps it out of runtime code
- [ ] "Original" YouTube downloads fetch a thumbnail that their WebM can't hold (`--write-thumbnail` is passed for every format but WAV). Skip it when the original will be WebM, or say in the UI that "original" has no artwork

## Phase 4 — DJ polish
- [ ] Settings page (format, filename template, artwork, concurrency, auto-download singles, sign-ins)
- [ ] Artist/title clean-up rules ("Official Video", "[HD]", "Lyrics", …) with preview
- [ ] Already-downloaded detection (download archive) with badges in the track list. Until then, downloading a known playlist again downloads every track again (each ends `skipped` at publish) and spends the platform's pacing budget
- [ ] Persistent download history
- [ ] Optional sign-ins, per platform and opt-in: browser cookies for age-restricted YouTube, SoundCloud login for originals and Go+ (never passed in argv)
- [ ] Keyboard shortcuts (paste, select all, download, cancel)
- [ ] A full data drive (`disk_full` from yt-dlp, ffmpeg or the job dir) fails only the jobs that hit it, plus the queued jobs for the same target folder. Decide whether it should fail or pause every queued job instead, since they all need the data drive
- [ ] Share rate-limit cooldowns between enrichment and downloads. They share SoundCloud's token bucket, but a 429 pauses only the side that saw it (ADR-017)
- [ ] Stall detection, if hangs show up in practice. Retry sleeps and forced waits print nothing in quiet mode, so a no-output timer must allow for them (`waitingUntil`). Today only the 20 s socket timeout and cancel bound a download
- [ ] Check in rekordbox, Serato and Traktor that they read our tags: the COMM frame in MP3, the trailing `ID3 ` chunk (tags and cover) in AIFF, FLAC's `DESCRIPTION` comment, and titles with combining characters (tags keep the platform's text; only file names are NFC)

## Phase 5 — Distribution (optional)
- [ ] App-managed yt-dlp (pinned, unpacked `yt-dlp_macos.zip` build; the app downloads stable/nightly updates itself, since that build can't use `-U`) and ffmpeg/ffprobe
- [ ] Desktop wrapper (Tauri or Electron) and Windows support

## Ideas (unscheduled)
BPM/key detection · Rekordbox XML / M3U export · square-crop 16:9 YouTube artwork · Spotify playlist → match tracks on YouTube/SoundCloud · first-class Bandcamp and Mixcloud
