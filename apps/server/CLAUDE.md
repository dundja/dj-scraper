# apps/server: local API + download engine

A Node + Hono server bound to `127.0.0.1`. It owns everything that touches the OS: spawning yt-dlp/ffmpeg, the download queue, settings, and the filesystem. The design is in `docs/architecture.md`; yt-dlp flags and quirks are in the `ytdlp` skill.

## Layout
```
src/
  index.ts          boot: config → data dir, lock, sweep → settings, services → listen; engine check; signals
  shutdown.ts       the graceful shutdown order, shared by index.ts and test/downloads-app.ts
  services.ts       createServices: the resolver, enricher and download pipeline wired once (one SoundCloud bucket
                    for lookups and downloads), for index.ts, scripts/smoke-download.ts and test/downloads-app.ts
  config.ts         env + --dev/--open → Config (Zod); DJS_WEB_DIST, DJS_DATA_DIR, homeDir; default folders
  data-dir.ts       prepareDataDir (0700, ours), lockDataDir (server.lock, O_EXLOCK|O_NOFOLLOW), sweepLeftovers (ps → kill
                    leftover groups, part files, jobs/ entries) with pure parsePs/leftoverGroups (ADR-018)
  startup.ts        after listen: missing-UI warning, --open (/usr/bin/open via engine/run.ts)
  server.ts         startServer on 127.0.0.1 (node:http + Hono listener)
  app.ts            Hono app: security headers, guard, /api routes, built UI (not --dev), notFound/onError
  stubs.ts          UNUSED_* deps for tests of other routes (createApp needs every service)
  http/             guard.ts (Host/Origin/Fetch-Metadata, JSON-only; --dev trusts the Vite port), errors.ts (ApiError
                    with an optional status override, status map), security-headers.ts (anti-framing, nosniff,
                    no-referrer on every response), json.ts (readJson(c, Schema), jsonBodyLimit, jsonBodyLimitOf)
  routes/           system.ts (health, recheck), resolve.ts (resolve, entries), downloads.ts (create, list, cancel,
                    retry, reveal, bulk cancel/retry/clear), events.ts (SSE: createEventStreams), settings.ts,
                    folders.ts (folder picker), web.ts (the built UI + SPA fallback, ADR-012)
  resolve/          plan.ts (pure: URL + mode → yt-dlp call), resolver.ts (POST /api/resolve),
                    enricher.ts (POST /api/resolve/entries: pacing, budget, cooldown, cache; peek for downloads),
                    limiter.ts, lru.ts, input.ts (checkUrl), ytdlp-call.ts
  engine/
    binaries.ts     find yt-dlp/ffmpeg/ffprobe (YTDLP_PATH/FFMPEG_PATH → PATH), JS runtime, versions → Health;
                    locateEngine for downloads (no spawn)
    versions.ts     pure: version output parsers, minimums
    health.ts       cached health check (the boot log words problems with shared healthProblems)
    run.ts          the only module that spawns processes; SIGKILLs the group when a run closes
    ytdlp-args.ts   pure: base, resolve, entry and download argv; download selectors
    ytdlp-parse.ts  pure: info JSON → Track/Collection; trackNames (shared with finalize)
    ytdlp-progress.ts pure: one download line → DL / PP / START / DONE; waitingUntil
    ytdlp-errors.ts pure: stderr + exit code → ErrorInfo (ordered pattern tables); mapDownloadExit
    finalize-plan.ts pure: tags, comment URL, file name, codec plan, muxer table, ffmpeg/ffprobe argv, probe
                    parsing, readback checks, ffmpeg error text, cover sniffing (ADR-015, ADR-016)
    id3.ts          pure: our ID3v2.3 tag and the AIFF ID3 chunk
    finalize.ts     probe → cover pass → audio pass → readback → ID3 tag, in <jobDir>/finalize/
  fs/               folders.ts (resolveTargetFolder, recheckFolder, insideFolder), move.ts (createPublish: never
                    overwrites), folder-picker.ts (osascript choose folder), reveal.ts (open -R)
  jobs/             types.ts (StartInfo, DoneInfo, TargetFolder, attempt/finalize/publish types, StepError),
                    attempt.ts (one attempt: job dir, yt-dlp, finalize, publish, cleanup), queue.ts (state
                    machine, run order, concurrency, cancel/retry/clear), bus.ts (typed events)
  pacing/           token-bucket.ts (GCRA, shareable, with a reserve), gates.ts (per-platform admission, ADR-017)
  settings/         store.ts (settings.json: field-wise repair, settings.json.bad, atomic coalesced writes)
  util/             errno.ts (errnoCode, failureName: what a log may say about an error), fields.ts (lenient,
                    omitUndefined for tool JSON and optional contract fields)
src/**/*.test.ts    unit tests, next to the source
scripts/smoke.ts    `pnpm smoke`: the real resolver against live platforms (the only network path), and with
                    --download the real download pipeline (scripts/smoke-download.ts) into a temp dir
test/
  *.test.ts         tests that spawn processes or open sockets (afterEach killActiveGroups)
  helpers.ts        test helpers (fake tools incl. writeFakeYtdlp, writeFakeFfmpeg, writeFakeEngine; serverEnv;
                    temp dirs, engine fixtures, free ports, raw requests, web dist); no src/ imports
  e2e-server.ts     Playwright's webServer: the production server on PORT with a healthy fake engine
  entry.ts          bootEntry: the real entry (node src/index.ts) as a child, with its lines; lockHolder
  resolve-app.ts    harness for the resolve/entries integration tests (real server + fake yt-dlp)
  downloads-app.ts  harness for the downloads integration tests (real server + createServices + fake engine, SSE reader)
  services.test.ts  createServices as the server builds it: SoundCloud lookups and downloads share one budget (D8)
  downloads.test.ts downloads end to end; lifecycle.test.ts: shutdown, boot sweep, a second server
  id3-reader.ts     an ID3v2 reader written apart from the writer, for MP3/AIFF readback in tests and smoke
  finalize-real-ffmpeg.test.ts, move-exfat.test.ts   opt-in (DJS_TEST_REAL_FFMPEG=1, DJS_TEST_EXFAT=1)
  smoke-download.test.ts   the smoke script's download path, offline against the fake engine
  fake-tool.sh      one checked-in fake binary that tests symlink as yt-dlp/ffmpeg/ffprobe/deno; keep its exec bit
  fake-yt-dlp.mjs   replays fixtures, -J and downloads (exec bit kept); symlink it via writeFakeYtdlp
  fake-ffmpeg.mjs   fake ffmpeg and ffprobe in one script (exec bit kept); symlink it via writeFakeFfmpeg
  fake-media.mjs    the fake media format both fakes share (FAKEAUDIO, fake images); imported, never run
  fixtures/         recorded output: engine/ (version probes), youtube/ + soundcloud/ (-J JSON), errors/ (stderr .log),
                    downloads/ (stdout + stderr per download run), ffprobe/ (ffprobe JSON of sources and outputs),
                    each with a README.md (version, date, synthetic or not); trim.mjs scrubs new -J recordings;
                    fake-yt-dlp.json maps URL + flags → fixture for the fake engine
```

## Rules
- **Spawning.** Processes start only in `engine/run.ts`, as `spawn(bin, argv, { shell: false, detached: true })`; detached gives each run its own process group for cancel. The argv comes from pure builders, always includes `--ignore-config`, and puts the URL after `--`. Never use `exec` or string commands. A download gets only the classified URL (`checkUrl`), never the request's string.
- **Pure core, thin edges.** Argv builders, parsers, finalize's decisions (`finalize-plan.ts`), the ID3 writer and the gates are pure functions or clock-injected objects with unit tests. Routes only validate, call a service, and respond.
- **Contract.** Validate every request with the `@dj-scraper/shared` schemas and return shared types. Errors are `{ error: { code, message } }` with a typed `ErrorCode`: throw `ApiError(code, message)`, and `http/errors.ts` maps the code to its HTTP status; pass `{ status }` only for the documented overrides (409, 503). Inside the pipeline, throw `StepError(code, message)` and convert it at the route. Messages never hold paths.
- **Distrust yt-dlp JSON.** Parse it with tolerant schemas (most fields optional) and normalize it. Extractors change their fields over time. The same goes for `DL`/`START`/`DONE` lines and ffprobe JSON.
- **Files.** yt-dlp writes only into the attempt's job dir (`<dataDir>/jobs/<attemptId>`), and finalize only into its `finalize/`. Paths yt-dlp prints must resolve to regular files inside the job dir. Publish (`fs/move.ts`):
  - rechecks that the folder is still the real path resolved at enqueue, and never creates it
  - claims the sanitized name with `link` or an exclusive create, never `rename` onto it, so an existing file means `skipped`
  - records a cross-volume part file in `jobs/<attemptId>.part.json` before copying
- **ffmpeg.** Every pass: `-hide_banner -nostdin -loglevel error -n`, `-protocol_whitelist file` before each input, explicit `-map` and `-f`, absolute paths, `-xerror` when decoding anything but an MP3 (ADR-015), never `-vn`. Exit 0 proves nothing: read the output back with ffprobe. An MP3's duration is measured, never taken from ffprobe (it may be an estimate).
- **Jobs.** Each attempt settles exactly once, and one failing job never affects the others (except the documented fan-outs: `disk_full`/`folder_unavailable` per folder, a persistent bot check per platform).
- **Cancel.**
  1. Send SIGINT to the process group. Not SIGTERM: it can orphan ffmpeg.
  2. Send SIGKILL after 3 s (`KILL_GRACE_MS`).
  3. Delete the job dir once `run` has settled (its group is gone by then).
- **Pacing.** Downloads go through `pacing/gates.ts` (ADR-017); lookups through the enricher's limiter (ADR-014). SoundCloud's token bucket is one instance shared by both (`productionPacing` in `services.ts`; never build the services by hand). Every platform decision uses the classified URL's platform, never `TrackRef.platform`. No yt-dlp `--sleep-*` flags.
- **Data dir.** One server holds it (`server.lock`); the startup sweep relies on that. Only `jobs/` entries named `<uuid>` or `<uuid>.part.json` are ours to delete, and nothing there follows symlinks. A part record whose folder is missing (a drive not plugged in) is kept for up to 30 days. The sweep finds leftover processes by `<dataDir>/jobs/<uuid>` in their argv, so every engine argv of an attempt must name its job dir (yt-dlp's `-P`, ffmpeg's absolute paths).
- **SSE.** `GET /api/events` writes a raw `retry: 1000`, then a snapshot taken in the same tick as the bus subscription, then every event in order. Heartbeats are a typed `{ type: 'heartbeat' }` every 15 s (comments never reach page JS). No progress throttle: `--progress-delta 0.5` already caps DL lines at about two a second per job. A bulk change is one event. Unsubscribe on disconnect, and end every stream cleanly at shutdown. HEAD never opens a stream (Hono runs the GET handler for it and drops the body unread, so the stream would never hear the client go). The bus serializes each event once and checks it against `ServerEventSchema` in dev and tests.
- **Fixtures.** Record new cases with real yt-dlp (and ffprobe), and note each in its directory's README (URL, options, exit, version, date; mark synthetic logs as such). Meta-tests fail if a fixture lacks its test entry or manifest rule:
  - A `-J` dump goes through `test/fixtures/trim.mjs` (it refuses output that still holds IPs or signed URLs) and gets a `RECORDED_URLS` entry in `ytdlp-parse.test.ts`.
  - A stderr `.log` is kept verbatim and gets a `FIXTURES` entry in `ytdlp-errors.test.ts`.
  - A download case (`downloads/<case>.stdout.log` + `.stderr.log`, the job dir as `{JOBDIR}`) gets a `DOWNLOAD_FIXTURES` row in `ytdlp-progress.test.ts` and a `DOWNLOAD_FAILURES` or `DOWNLOAD_SUCCESSES` entry in `ytdlp-errors.test.ts`.
  - An ffprobe JSON (`ffprobe/<name>.json`, recorded with finalize's `-show_entries`) gets a `PROBES` entry in `finalize-plan.test.ts`.
  - Recordings get a `fake-yt-dlp.json` rule (`download: '<case>'` for download cases), or a `WITHOUT_RULES` reason in `test/fake-yt-dlp.test.ts`.
- **Fake binaries.** `fake-yt-dlp.mjs`, `fake-ffmpeg.mjs` and `fake-tool.sh` are checked in with their exec bit (git mode 100755) and symlinked per test: endpoint security scans every newly written executable on its first run. The fakes exit 2 on argv our builders never produce, so drift fails loudly.
- **Security middleware.** The Host/Origin guard and JSON-only mutations apply to every route. Never add CORS headers.
- **Tests.** Unit tests never spawn the real yt-dlp or touch the network. Integration tests use the fake engine. Live checks belong in `pnpm smoke`. Test harnesses that start the server itself (`test/entry.ts`, `test/e2e-server.ts`) may spawn `node` directly, never an engine binary. Every spawned server entry spreads `serverEnv(root)` from `test/helpers.ts` into its env (its own `DJS_DATA_DIR` and `HOME`), so no test touches the user's data dir or `~/Music`.
- **Logs.** Keep them short and structured: URL kind, counts, error codes, timings, platforms, and job ids (their first 8 characters). Never log URLs, titles, paths, argv, `DONE` lines, `ps` output, cookies or tokens, or the message of a filesystem or spawn error (log its code: `failureName` in `util/errno.ts`). A SoundCloud secret link is a credential (see `docs/architecture.md` > Security model).
