# apps/server: local API + download engine

A Node + Hono server bound to `127.0.0.1`. It owns everything that touches the OS: spawning yt-dlp/ffmpeg, the download queue, settings, and the filesystem. The design is in `docs/architecture.md`; yt-dlp flags and quirks are in the `ytdlp` skill.

## Target layout
```
src/
  index.ts          boot: config, serve, engine check, graceful shutdown
  config.ts         env + --dev/--open → Config (Zod); DJS_WEB_DIST, default apps/web/dist
  startup.ts        after listen: missing-UI warning, --open (/usr/bin/open via engine/run.ts)
  server.ts         startServer on 127.0.0.1 (node:http + Hono listener)
  app.ts            Hono app: security headers, guard, /api routes, built UI (not --dev), notFound/onError
  http/             guard.ts (Host/Origin/Fetch-Metadata, JSON-only; --dev trusts the Vite port), errors.ts (ApiError,
                    status map), security-headers.ts (anti-framing, nosniff, no-referrer on every response)
  routes/           system (health), web (the built UI + SPA fallback, ADR-012); later resolve, downloads,
                    events (SSE), settings, folder picker
  engine/
    binaries.ts     find yt-dlp/ffmpeg/ffprobe (YTDLP_PATH/FFMPEG_PATH → PATH), JS runtime, versions → Health
    versions.ts     pure: version output parsers, minimums
    health.ts       cached health check (the boot log words problems with shared healthProblems)
    run.ts          the only module that spawns processes
    ytdlp-args.ts   pure: options → argv
    ytdlp-parse.ts  pure: info JSON → Track/Collection, DL/PP/DONE lines, stderr → ErrorCode
    finalize.ts     artist/title + filename (pure), tags/AIFF via ffmpeg, safe move
  jobs/             queue.ts (concurrency, pacing, state machine), bus.ts (typed events)
  settings/         Zod-validated settings.json in the app data dir
  fs/               folder picker, path safety, filename sanitizing
src/**/*.test.ts    unit tests, next to the source
test/
  *.test.ts         tests that spawn processes or open sockets (afterEach killActiveGroups)
  helpers.ts        test helpers (fake tools, temp dirs, engine fixtures, free ports, raw requests, web dist)
  e2e-server.ts     Playwright's webServer: the production server on PORT with a healthy fake engine
  fake-tool.sh      one checked-in fake binary that tests symlink as yt-dlp/ffmpeg/ffprobe/deno; keep its exec bit
  fixtures/         recorded output: engine/ (version probes), <platform>/<case>.json|.log + README.md (version, date)
  fake-yt-dlp.mjs   replays fixtures; point YTDLP_PATH at it in integration/e2e tests
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
- **Pacing.** Respect per-platform limits. On `rate_limited`, pause that platform's queue instead of failing the whole batch.
- **SSE.** Send a heartbeat every ~15 s, unsubscribe on disconnect, and throttle progress to about 4 events/s per job.
- **Security middleware.** The Host/Origin guard and JSON-only mutations apply to every route. Never add CORS headers.
- **Tests.** Unit tests never spawn the real yt-dlp or touch the network. Integration tests use the fake engine. Live checks belong in `pnpm smoke`. Test harnesses that start the server itself (`test/boot.test.ts`, `test/e2e-server.ts`) may spawn `node` directly, never an engine binary.
- **Logs.** Keep them short and structured, include job and track ids, and never log cookies, tokens or argv that contains secrets.
