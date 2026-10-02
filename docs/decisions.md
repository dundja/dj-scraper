# Architecture Decision Records

Short, dated records of the decisions that shape DJ Scraper. Don't reverse one silently — add a new record that supersedes it.

## ADR-001 — Local-first, single user
*2026-10-01 · accepted*

**Context.** Downloads must land in a folder the user picks. A hosted service would need accounts, storage and rate limiting, gets bot-blocked by YouTube on datacenter IPs, and carries legal risk.

**Decision.** DJ Scraper runs entirely on the user's Mac: a local Node server bound to `127.0.0.1` plus a browser UI at localhost. The server writes files straight to disk.

**Consequences.** No auth, no cloud storage. Because the server can spawn processes and write files, it must refuse requests from other websites (Host/Origin checks, JSON-only mutations). Packaging for other users (bundled binaries, desktop wrapper, Windows) is an optional later phase.

## ADR-002 — Vite + React SPA with a separate Hono server, in a pnpm monorepo
*2026-10-01 · accepted*

**Context.** The user prefers React + Vite and suggested TanStack Start or Next.js. The core of the app is a long-running, stateful process manager (download queue, child processes, live progress). SEO and SSR are irrelevant.

**Decision.** `apps/web` is a Vite SPA (React, TanStack Router + Query, Tailwind, shadcn/ui). `apps/server` is plain Node + Hono (JSON API + Server-Sent Events). `packages/shared` holds the Zod contract. In dev, Vite proxies `/api` to the server; in production, the server also serves the built SPA.

**Rejected.** *TanStack Start* — SSR goes unused, a background queue fits awkwardly in a framework server with HMR, and its fast-moving APIs raise the odds of agents writing outdated code. *Next.js* — not Vite-based; App Router/RSC complexity buys nothing here.

**Consequences.** Two processes in dev, started by one `pnpm dev`. Clean seam for a future desktop wrapper: the SPA stays as is and the server becomes a sidecar.

## ADR-003 — yt-dlp CLI + ffmpeg as the download engine
*2026-10-01 · accepted*

**Context.** We want "any platform", and YouTube changes often. JS-native libraries (ytdl-core forks, play-dl, soundcloud-downloader) cover few sites and break regularly. yt-dlp supports well over a thousand sites and usually ships fixes within days.

**Decision.** Spawn the yt-dlp CLI, plus ffmpeg/ffprobe for conversion and tagging, as child processes. The CLI is yt-dlp's stable interface (its Python API is not), and it keeps the stack TypeScript-only.

**Consequences.** External binaries are a runtime dependency: health check, clear UI when missing or outdated, and keeping yt-dlp updated is part of running the app. We parse yt-dlp's JSON output and our own progress template, both covered by fixture tests.

## ADR-004 — Default output: MP3 320 kbps, honest about quality
*2026-10-01 · accepted (default chosen by the assistant; easy to change)*

**Context.** Every DJ app and CDJ plays MP3; support for Opus/WebM is poor. Sources are lossy (roughly 128–256 kbps).

**Decision.** Default to MP3 320 kbps CBR with ID3 tags and embedded artwork. Also offer M4A (no re-encode when the source is AAC), AIFF, WAV, FLAC and "original". Show the source codec/bitrate in the UI and never present an upconverted file as higher quality.

**Consequences.** Re-encoding costs a little quality and time; users who care can choose M4A or original.

## ADR-005 — Tooling: TypeScript strict, Biome, Vitest, Playwright
*2026-10-01 · accepted*

**Decision.** TypeScript in strict mode everywhere; Biome for lint + format (one fast tool, no ESLint/Prettier); Vitest for unit and integration tests; Playwright for e2e; pnpm workspaces; Node 24 LTS. `packages/shared` is consumed as TypeScript source, without a build step.

**Consequences.** The agents' format-on-edit hook runs Biome. How the server runs in production (bundled vs. Node's native TypeScript support) is decided during scaffolding (roadmap Phase 0).

## ADR-006 — yt-dlp works in a per-job temp dir; our finalize step owns the final file
*2026-10-01 · accepted*

**Context.** yt-dlp has gaps for DJ use:
- `-x` can't produce AIFF.
- It can't embed artwork in WAV or AIFF.
- Its `--parse-metadata` recipe splits "Artist - Title" at the last dash.
- Cancelled downloads leave `.part`/temp files behind.

We also want user-edited artist/title and clean-up rules.

**Decision.**
- Each job gets its own temp dir. yt-dlp downloads and converts only there (`-o "%(id)s.%(ext)s"`) and prints the final path plus metadata as JSON.
- Our finalize step then:
  - decides artist/title
  - writes tags
  - converts to AIFF when asked (ffmpeg)
  - builds and sanitizes the filename
  - checks for an existing file
  - moves the file into the target folder

**Consequences.**
- Partial files never reach the user's folder, and cancel is simply kill + delete the job dir.
- Naming and tagging are our own pure, testable logic.
- Moving across volumes (USB drives) needs copy + unlink.

## ADR-007 — Toolchain: pnpm 12, TypeScript 7, TypeScript that type stripping can run
*2026-10-02 · accepted*

**Context.** Phase 0 scaffolds on the current releases:
- pnpm 12.8, a Rust rewrite whose settings live in `pnpm-workspace.yaml`
- TypeScript 7.0, a native compiler with no JS API until 7.1
- Biome 2.5
- Node 24 LTS (Node 26 becomes LTS on 2026-10-28)

ADR-005 left open whether the server runs bundled or on Node's native TypeScript support.

**Decision.**
- Pin pnpm 12.8.1 in `packageManager`. Enforce Node 24 with `devEngines.runtime` (`^24.11.0`, `onFail: "error"`), because pnpm 12 ignores a root `engines` mismatch; `engines` stays as documentation.
- Use TypeScript 7 (`~7.0.2`, from the pnpm catalog) for typechecking only. Write source that Node's type stripping can run as is: `.ts` import extensions, `import type`, `erasableSyntaxOnly`. This keeps both server options from ADR-005 open.
- Root scripts delegate to same-named package scripts through `pnpm -r` and `--filter`. No Turborepo or Nx: three packages don't need a task runner.
- Biome style: single quotes, no semicolons, 100 columns. `any`, unused imports and variables, non-null assertions, value imports of types and relative imports without an extension are errors, not warnings. Generated code (`routeTree.gen.ts`, shadcn/ui components) isn't linted.

**Rejected.**
- *TypeScript 6.* It works with the same configs, but 7 is the current stable and faster. Falling back stays cheap.
- *pnpm 11.* It uses the same files and worked with the old Homebrew pnpm 10.17, but 12 is stable and is Homebrew's default.

**Consequences.**
- No tool may depend on the TypeScript JS API (typescript-eslint, vite-plugin-checker, vue-tsc). If one becomes necessary, alias `typescript` to `npm:@typescript/typescript6` and install TS 7 as `@typescript/native`.
- Homebrew pnpm 10.17 can't switch to the pinned 12.x on macOS (ENOEXEC). `brew upgrade pnpm` fixes it.
- Moving to Node 26 means changing `.nvmrc`, `engines`, `devEngines` and `@types/node` together.

## ADR-008 — Collection rows can be partial
*2026-10-02 · accepted*

**Context.** `yt-dlp --flat-playlist` lists SoundCloud set entries as id + url only, sometimes with an API URL instead of the page URL. SoundCloud user pages give id, url and title. The product lists sets instantly and fills rows in as they load. Inventing titles (e.g. from URL slugs) would put made-up metadata into the contract.

**Decision.** `Collection.entries` holds `CollectionEntry`, a discriminated union on a required `partial` flag:
- `partial: false` is a full `Track`, whose title is required.
- `partial: true` has the same fields, but the title is optional.

The web enriches partial rows through `POST /api/resolve/entries`, which returns full `Track`s, and merges them by platform + id. `Track` stays strict everywhere else (single-track results, `ambiguous`, enrichment results).

**Rejected.** *Optional `Track.title` everywhere* weakens every consumer to serve one case. *A missing title as the enrichment signal* fails for SoundCloud user pages, whose rows have titles but no duration or artwork.

**Consequences.** The UI shows a placeholder until a row is enriched. A row's `url` isn't a stable key before enrichment. The server marks a row partial only when a per-track lookup can supply what the flat listing lacks (SoundCloud set and user-page rows). YouTube flat rows are never partial: `[Private video]`/`[Deleted video]` rows are full rows with `availability: 'unavailable'`, and a missing artist or duration doesn't make a row partial.

## ADR-009 — The server runs its TypeScript source on Node, with no build step
*2026-10-02 · accepted · settles the open question in ADR-005*

**Context.** ADR-005 left open whether the server ships bundled or runs on Node's native TypeScript support. Node 24.12 strips types without a flag or warning. Our source follows the conventions in ADR-007 (`.ts` imports, `import type`, erasable syntax only). `@dj-scraper/shared` loads as source through pnpm's workspace symlink.

**Decision.**
- Dev: `node --watch src/index.ts --dev`. It restarts on edits to the server and to `packages/shared`.
- Prod: `node src/index.ts`.
- `tsc` only typechecks, and `pnpm build` builds only the web app.
- Dev-only behavior (allowing the Vite origin) is switched on by the `--dev` flag, not by `NODE_ENV`, so it works the same on every OS.

**Rejected.** *Bundling the server (tsdown/esbuild)* adds a build step and source maps for no gain while the app runs from the repo. *tsx* adds a dependency (and esbuild's install script) for what Node now does itself.

**Consequences.**
- No `dist/` for the server, and stack traces point at the real source.
- Node refuses to strip types under `node_modules`, so the server must run from the repo with pnpm's symlinked workspace, not from a `pnpm deploy` copy or with `--preserve-symlinks`.
- A desktop wrapper (Phase 5) will need a bundle step then.
- `node --watch` waits for the old process on every restart, so shutdown is idempotent and has a hard deadline.

## ADR-010 — Web UI kit: shadcn/ui on Base UI with the Nova preset, dark only for now
*2026-10-02 · accepted (chosen by the assistant; reversible)*

**Context.** shadcn 4.x builds its components on one of three primitive libraries (`base` for Base UI, `radix`, `aria` for React Aria) and offers style presets (nova, vega, maia, lyra, mira, …). Its default (`init -d`) is `base-nova`. The app runs offline on localhost, so fonts and assets must ship with it.

**Decision.**
- shadcn/ui with Base UI (`@base-ui/react`) and the Nova preset (compact, Lucide icons, the Geist font bundled from `@fontsource-variable/geist`). Components come from the CLI (`pnpm dlx shadcn@4.21.1 add <name>` in `apps/web`) and are never patched by hand. They import `cn` from shadcn's `cn` package, which replaces clsx and tailwind-merge.
- Dark only: `<html class="dark">` and `color-scheme: dark`. shadcn's light tokens stay in `src/styles.css` for a later light theme.
- `@/*` is the alias for `src`, because shadcn's generated imports need it.

**Rejected.** *Radix*, shadcn's previous default: it works just as well, but upstream momentum has moved to Base UI. *Web fonts from a CDN*: the app must work offline.

**Consequences.** Base UI composes through a `render` prop instead of Radix's `asChild`, so check a generated component's API before using it. Switching libraries later means re-adding the components. `shadcn` itself is a dependency because the CSS imports its `shadcn/tailwind.css`.

## ADR-011 — The dev proxy keeps the browser's Host, and `--dev` trusts the Vite port
*2026-10-02 · accepted · replaces the Security model's earlier `changeOrigin: true` rule*

**Context.** The Security model used to require Vite's `/api` proxy to use `changeOrigin: true`, so requests reached the server with `Host: 127.0.0.1:4747`, and it relied on Vite's own host check against DNS rebinding. An attack run against `pnpm dev` (raw sockets plus Chromium, Chrome, WebKit and Firefox) found two gaps:
- Vite's host check is looser than our guard. It lets through a missing Host, any IP literal, `file:*`, `*-extension:*` and `localhost:<anything>`, and `file` or `x-extension` resolve through the DHCP search domain. Because `changeOrigin` hid the browser's Host, a rebinding page at `http://file:5173` could read `GET /api/health`.
- Vite served the page with no anti-framing headers, so any site could frame `localhost:5173` and turn one click on "Check again" into `POST /api/health/recheck` 200.

**Decision.**
- The proxy keeps the browser's Host (`changeOrigin: false`). With `--dev` the server's guard also accepts the Vite port: `localhost:5173` and `127.0.0.1:5173`, as Host and as origin. Our exact Host check is then the one DNS-rebinding defense in dev and in production.
- Vite sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (`server.headers`).
- A dev-server plugin (`apps/web/dev-guard.ts`) applies the guard's rules to every request Vite answers, not just `/api`. It checks the exact Host, using `loopbackHosts` from `packages/shared`, and the Fetch Metadata rule, `allowedByFetchMetadata`. Vite's `/__open-in-editor` is stricter: only a same-origin request or a client without Fetch Metadata may call it, so even a link from another site can't open files in the editor.
- `apps/web/vite-config.test.ts` pins these settings: the proxy's `changeOrigin: false`, `cors: false`, `strictPort`, the frame headers, and the dev guard registered ahead of Vite's middlewares.

**Rejected.** *Keep `changeOrigin: true` and add a proxy `bypass` that allows only the Vite hosts.* That would put the Host check for `/api` into config, outside the guard's tests. With `changeOrigin: false`, the guard's own exact check covers proxied requests, and the dev guard's Host check covers what Vite serves itself.

**Consequences.**
- With `--dev`, the server also accepts `Host: localhost:5173` on direct connections. That's harmless: a browser sends that Host only to port 5173, which is Vite.
- A foreign Host such as `file:5173` gets 403 from the dev guard for every page, module and endpoint Vite serves, and from the server's guard for `/api`. Visiting `http://[::1]:5173` directly is refused too; use `localhost:5173`.
- Production is unchanged: without `--dev`, nothing on port 5173 is trusted.

## ADR-012 — The server serves the built UI with its own small file server
*2026-10-02 · accepted*

**Context.** `pnpm start` has the server serve `apps/web/dist` next to `/api`. `@hono/node-server`'s `serveStatic` (2.1.3) joins its root with the decoded request path, so a relative root resolves against the cwd. It also serves dotfiles and follows symlinks out of its root. It brings Range and precompressed-file support that one local browser doesn't need.

**Decision.**
- `apps/server/src/routes/web.ts` is about 100 lines and is mounted after the guard and the `/api` routes:
  - It serves only path segments matching `^[\w-][\w.-]*$`.
  - The file's `realpath` must lie inside the dist dir's `realpath`, and only regular files are served.
  - It falls back to `index.html` for extensionless paths outside `/api`.
  - Hashed `/assets/*` files are cached as immutable; everything else is `no-cache`.
- Every response gets anti-framing, `nosniff` and `no-referrer` headers.
- The root `pnpm start` runs `pnpm build` first.

**Rejected.** *`serveStatic` with wrappers* for dotfiles, symlink containment and cache headers: that is more code than the file server, and the security depends on another library's path handling.

**Consequences.** No ETag, Last-Modified or Range support. Files in `apps/web/public` must have names inside the allowed character set. During a rebuild, which empties `dist`, requests can briefly get 404 until Vite finishes.

## ADR-013 — Resolve: one flat yt-dlp call, capped listings, `ambiguous` for a track inside a list
*2026-10-02 · accepted*

**Context.** Pasting a link must answer quickly with what it is: a track, a list, or both (`watch?v=…&list=…`). The roadmap asked to reconcile the original 1,000-entry cap with "smooth with 1,000+ tracks". Live probes with yt-dlp 2026.08.19 found:
- Listing 5,001 rows takes 38–56 s, and a 200-row playlist about 2 s.
- `playlist_count` is null for channel tabs, mixes and SoundCloud user pages.
- `playlist?list=RD…` is "unviewable", while `watch?v=X&list=RDX` lists the mix.
- A channel root lists its tabs, not its videos.

**Decision.**
- **One call.** Each resolve is a single `yt-dlp -J --flat-playlist -I 1:<cap+1>` call, planned by a pure function (`resolve/plan.ts`) from `classifyUrl` (shared) and the request's `mode`.
- **Caps.** The cap is 5,000 entries, YouTube's own playlist limit, and 50 for a mix, which never ends. Asking for one extra row makes `truncated` exact on every platform. `trackCount` is set only when the platform reports its own count.
- **Track inside a list.** `watch?v=…&list=…` in `auto` mode is one `--no-playlist` track lookup, answered as `ambiguous` with the list's `collectionUrl` and `collectionKind` (`playlist`, `album` or `mix`), so the UI can word the question and default to the track for a mix. `mode: 'collection'` then lists it.
- **Rewrites.** A mix's `collectionUrl` keeps its seed video, and `playlist?list=RD<video id>` is rewritten to that form. Channel roots resolve as `<channel>/videos`.
- **Kind and owner.** A SoundCloud set whose `album_type` is album, EP, single or compilation is kind `album`, as a YouTube album is, whatever URL it came from; playlists stay `set`. When yt-dlp names no owner, it is derived only where it is certain: a SoundCloud user page's is the username in its `<username> (<Resource>)` title, and a YouTube Music album's is the artist of the `<artist> - Topic` channel all its rows share. An album by several artists gets none.
- **DRM.** DRM services (Spotify, Apple Music, Amazon Music, Tidal, Deezer, Beatport) are refused by URL before anything is spawned (non-negotiable 7).
- **Limits.** At most 4 resolves run at once. The timeout is 60 s for a track and 180 s for a list, and a closed browser request stops its yt-dlp.

**Rejected.**
- *Keeping 1,000.* It cut ordinary channels and long playlists, and the UI virtualizes anyway.
- *Unlimited listings.* A 20,000-video channel would take minutes.
- *Streaming rows as they arrive* (`--lazy-playlist -j`). It needs a streaming API and progressive UI, so it is deferred until big lists prove slow in practice.
- *Answering a mix as a plain track.* That hides the choice, and `ambiguous` lets the UI default to the track instead.

**Consequences.** Lists over 5,000 rows show their first 5,000 and say so. A big channel takes tens of seconds to list, so the UI needs a visible loading state. `Collection` gained `trackCount`, `durationSec`, `truncated` and `skippedEntries`, and `ambiguous` gained `collectionKind`.

## ADR-014 — Partial rows are enriched lazily, one yt-dlp lookup per row, within each platform's budget
*2026-10-02 · accepted · implements ADR-008*

**Context.** SoundCloud set rows come back bare from the flat listing (ADR-008). A per-track `yt-dlp -J` lookup takes about 1 s, half of it process start, and costs 3–5 SoundCloud API requests: one lookup plus one per stream format. SoundCloud allows about 600 requests per 10 min. Narrowing the formats with `--extractor-args soundcloud:formats=…` saves 1–2 requests, but a track without the chosen formats fails with "No video formats found!". Skipping formats entirely costs one request, but loses the source codec and bitrate and Go+ preview detection, and honest audio needs both.

**Decision.**
- **Lookups.** `POST /api/resolve/entries` takes up to 25 rows (a screenful) and looks each up with `yt-dlp -J --flat-playlist --no-playlist`, using default formats. `--flat-playlist` keeps a URL that turns out to be a list from being fully extracted, and rows whose URL is a list are refused before spawning.
- **Results.** There is one result per distinct platform + id, `ok` with a full `Track` or `error` with an `ErrorInfo`. A removed track or a 429 fails only its row.
- **Pacing.** Pacing is per platform and keyed by the platform of the row's URL: two at a time with a minimum gap between starts. SoundCloud adds a token bucket, a burst of 25 lookups refilling one every 5 s, which keeps a long scroll within its budget. Rows wait for a token, and a request that the browser drops leaves the queue.
- **Cooldown.** A `rate_limited` row pauses its platform for 60 s, doubling up to 10 min. During the pause, rows fail at once without spawning.
- **Cache.** Results stay in memory for 30 min (2,000 rows), and concurrent requests for the same row share one lookup. Answers from the cache or a cooldown spend no pacing slot or budget token.

**Rejected.**
- *Calling SoundCloud's API ourselves* (`/tracks?ids=…` fills 50 rows per request). It re-implements extractor internals that yt-dlp keeps working (ADR-003).
- *Full extraction of the whole set up front* (no `--flat-playlist`). It is slow and spends the whole budget at once.
- *Failing rows when the budget runs low.* A wait is honest and recovers by itself.

**Consequences.**
- A fast scroll through a big set fills in at the budget's pace, about one row every 5 s after the first 25, so the UI must show placeholders and cancel requests for rows that scrolled away.
- Up to 10 yt-dlp processes can run at once: 4 resolves plus 2 per platform for enrichment.
- Phase 2 should decide format narrowing together with the download argv, because the source shown at enrichment should match what the download picks.
