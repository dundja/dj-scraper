# apps/server: local API + download engine

A Node + Hono server bound to `127.0.0.1`. It owns everything that touches the OS: spawning yt-dlp/ffmpeg, the download queue, settings, and the filesystem. The design is in `docs/architecture.md`; yt-dlp flags and quirks are in the `ytdlp` skill.

## Layout
Entries marked (Phase 2) don't exist yet.
```
src/
  index.ts          boot: config, serve, engine check, graceful shutdown
  config.ts         env + --dev/--open → Config (Zod); DJS_WEB_DIST, default apps/web/dist
  startup.ts        after listen: missing-UI warning, --open (/usr/bin/open via engine/run.ts)
  server.ts         startServer on 127.0.0.1 (node:http + Hono listener)
  app.ts            Hono app: security headers, guard, /api routes, built UI (not --dev), notFound/onError
  http/             guard.ts (Host/Origin/Fetch-Metadata, JSON-only; --dev trusts the Vite port), errors.ts (ApiError,
                    status map), security-headers.ts (anti-framing, nosniff, no-referrer on every response),
                    json.ts (readJson(c, Schema), body limit)
  routes/           system.ts (health, recheck), resolve.ts (resolve, entries), web.ts (the built UI + SPA fallback,
                    ADR-012); (Phase 2) downloads, events (SSE), settings, folder picker
  resolve/          plan.ts (pure: URL + mode → yt-dlp call), resolver.ts (POST /api/resolve),
                    enricher.ts (POST /api/resolve/entries: pacing, budget, cooldown, cache),
                    limiter.ts, lru.ts, input.ts, ytdlp-call.ts; unused.ts (stub deps for other routes' tests)
  engine/
    binaries.ts     find yt-dlp/ffmpeg/ffprobe (YTDLP_PATH/FFMPEG_PATH → PATH), JS runtime, versions → Health
    versions.ts     pure: version output parsers, minimums
    health.ts       cached health check (the boot log words problems with shared healthProblems)
    run.ts          the only module that spawns processes
    ytdlp-args.ts   pure: options → argv
    ytdlp-parse.ts  pure: info JSON → Track/Collection (DL/PP/DONE progress lines in Phase 2)
    ytdlp-errors.ts pure: stderr + exit code → ErrorInfo (ordered pattern table)
    finalize.ts     (Phase 2) artist/title + filename (pure), tags/AIFF via ffmpeg, safe move
  jobs/             (Phase 2) queue.ts (concurrency, pacing, state machine), bus.ts (typed events)
  settings/         (Phase 2) Zod-validated settings.json in the app data dir
  fs/               (Phase 2) folder picker, path safety, filename sanitizing
src/**/*.test.ts    unit tests, next to the source
scripts/smoke.ts    `pnpm smoke`: the real resolver against live platforms (the only network path)
test/
  *.test.ts         tests that spawn processes or open sockets (afterEach killActiveGroups)
  helpers.ts        test helpers (fake tools incl. writeFakeYtdlp, temp dirs, engine fixtures, free ports, raw requests,
                    web dist)
  e2e-server.ts     Playwright's webServer: the production server on PORT with a healthy fake engine
  resolve-app.ts    harness for the resolve/entries integration tests (real server + fake yt-dlp)
  fake-tool.sh      one checked-in fake binary that tests symlink as yt-dlp/ffmpeg/ffprobe/deno; keep its exec bit
  fixtures/         recorded output: engine/ (version probes), youtube/ + soundcloud/ (-J JSON), errors/ (stderr .log),
                    each with a README.md (version, date, synthetic or not); trim.mjs scrubs new recordings;
                    fake-yt-dlp.json maps URL + flags → fixture for the fake engine
  fake-yt-dlp.mjs   replays fixtures (exec bit kept); symlink it via writeFakeYtdlp and point YTDLP_PATH at it
```

## Rules
- **Spawning.** Processes start only in `engine/run.ts`, as `spawn(bin, argv, { shell: false, detached: true })`; detached gives each job its own process group for cancel. The argv comes from pure builders, always includes `--ignore-config`, and puts the URL after `--`. Never use `exec` or string commands.
- **Pure core, thin edges.** Argv builders, parsers, and finalize's naming/tagging decisions are pure functions with fixture-based unit tests. Routes only validate, call a service, and respond.
- **Contract.** Validate every request with the `@dj-scraper/shared` schemas and return shared types. Errors are `{ error: { code, message } }` with a typed `ErrorCode`: throw `ApiError(code, message)`, and `http/errors.ts` maps the code to its HTTP status.
- **Distrust yt-dlp JSON.** Parse it with tolerant schemas (most fields optional) and normalize it. Extractors change their fields over time.
- **Files.** yt-dlp writes only into the job's temp dir. Finalize then:
  - builds the filename and sanitizes it
  - asserts the path is inside the absolute target folder
  - moves the file in, never overwriting
- **Jobs.** Each attempt settles exactly once, and one failing job never affects the others.
- **Cancel.**
  1. Send SIGINT to the process group. Not SIGTERM: it can orphan ffmpeg.
  2. Send SIGKILL after a grace period.
  3. Delete the job dir.
- **Pacing.** Respect per-platform limits. On `rate_limited`, pause that platform's queue instead of failing the whole batch (the enricher does this already; see ADR-014).
- **Fixtures.** Record new cases with real yt-dlp, and note each in its directory's README (URL, options, exit, version, date; mark synthetic logs as such). Meta-tests fail if a fixture lacks its test entry or manifest rule:
  - A `-J` dump goes through `test/fixtures/trim.mjs` (it refuses output that still holds IPs or signed URLs) and gets a `RECORDED_URLS` entry in `ytdlp-parse.test.ts`.
  - A stderr `.log` is kept verbatim and gets a `FIXTURES` entry in `ytdlp-errors.test.ts`.
  - Both get a `fake-yt-dlp.json` rule, or a `WITHOUT_RULES` reason in `test/fake-yt-dlp.test.ts`.
- **SSE.** Send a heartbeat every ~15 s, unsubscribe on disconnect, and throttle progress to about 4 events/s per job.
- **Security middleware.** The Host/Origin guard and JSON-only mutations apply to every route. Never add CORS headers.
- **Tests.** Unit tests never spawn the real yt-dlp or touch the network. Integration tests use the fake engine. Live checks belong in `pnpm smoke`. Test harnesses that start the server itself (`test/boot.test.ts`, `test/e2e-server.ts`) may spawn `node` directly, never an engine binary.
- **Logs.** Keep them short and structured: URL kind, counts, error codes, timings, and job and track ids. Never log URLs, titles, argv, cookies or tokens; a SoundCloud secret link is a credential (see `docs/architecture.md` > Security model).
