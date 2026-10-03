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
*2026-10-01 · accepted (default chosen by the assistant; easy to change) · amended by ADR-015*

**Context.** Every DJ app and CDJ plays MP3; support for Opus/WebM is poor. Sources are lossy (roughly 128–256 kbps).

**Decision.** Default to MP3 320 kbps CBR with ID3 tags and embedded artwork. Also offer M4A (no re-encode when the source is AAC), AIFF, WAV, FLAC and "original". Show the source codec/bitrate in the UI and never present an upconverted file as higher quality.

**Consequences.** Re-encoding costs a little quality and time; users who care can choose M4A or original.

## ADR-005 — Tooling: TypeScript strict, Biome, Vitest, Playwright
*2026-10-01 · accepted*

**Decision.** TypeScript in strict mode everywhere; Biome for lint + format (one fast tool, no ESLint/Prettier); Vitest for unit and integration tests; Playwright for e2e; pnpm workspaces; Node 24 LTS. `packages/shared` is consumed as TypeScript source, without a build step.

**Consequences.** The agents' format-on-edit hook runs Biome. How the server runs in production (bundled vs. Node's native TypeScript support) is decided during scaffolding (roadmap Phase 0).

## ADR-006 — yt-dlp works in a per-job temp dir; our finalize step owns the final file
*2026-10-01 · accepted · amended by ADR-015 (yt-dlp no longer converts) and ADR-018*

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
*2026-10-02 · accepted · amended by ADR-023 (`lists`)*

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
*2026-10-02 · accepted · implements ADR-008 · amended by ADR-017 · the web side is ADR-022*

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

## ADR-015 — yt-dlp only downloads; finalize converts, tags and adds artwork in one ffmpeg pass
*2026-10-03 · accepted · supersedes ADR-006's "yt-dlp converts"; amends ADR-004 · amended 2026-10-03 (MP3 sources: measured duration, no `-xerror`; no thumbnail for a YouTube original)*

**Context.** ADR-006 had yt-dlp download and convert (`-x --audio-format …`) in the job dir. Live runs with yt-dlp 2026.08.19 and ffmpeg 8.0 showed that `-x`:
- converts silently: a SoundCloud MP3 128 kbps source became AAC "160 kbps" for M4A (lossy to lossy, with a bigger number), and FLAC from Opus came out 24-bit;
- copies an MP3 source for "MP3 320" and ignores `--audio-quality`, so the requested format says nothing about the file;
- leaks the source container's tags into every output, even without `--embed-metadata`;
- can't make AIFF, and `--embed-thumbnail` fails on WAV and AIFF.

ffmpeg's exit code proves nothing either: it exits 0 on truncated or corrupt input (a truncated WebM even with `-xerror`) and when the output already exists, also with `-n`.

**Decision.**
- **yt-dlp downloads the selected stream as is** (no `-x`) into `<dataDir>/jobs/<attemptId>`, plus `--write-thumbnail` when the file can hold a cover (`canHoldCover`, see the amendment on YouTube originals). The selectors are in ADR-017.
- **Finalize** (`engine/finalize.ts`; every decision is pure, in `engine/finalize-plan.ts`) works in `<jobDir>/finalize/` with fixed names: ffprobe the download → plan → cover pass → one audio pass → ffprobe the output → our ID3 tag for MP3 and AIFF (ADR-016).
- **Codec plan.** Copy when the source already has the target codec, else encode, at the native sample rate:

  | Format | Copied when the source is | Otherwise | Container |
  |---|---|---|---|
  | mp3 | MP3 | libmp3lame 320 kbps CBR | mp3 |
  | m4a | AAC | aac 256 kbps | ipod (`.m4a`, faststart) |
  | flac | FLAC | flac, 16-bit | flac |
  | wav | – | pcm_s16le | wav |
  | aiff | – | pcm_s16be | aiff |
  | original | always | – | from a closed table: Opus/Vorbis in WebM → `.webm`, AAC → `.m4a`, MP3, FLAC, Ogg; anything else fails `postprocess_failed` |

  More than two channels are mixed down to stereo, which forces an encode. WAV and AIFF refuse a track that would pass 4 GiB. A download that ffprobe reads as a playlist (hls, dash, concat) is refused.
- **Every pass** runs `-hide_banner -nostdin -loglevel error -n`, `-protocol_whitelist file` before each input, explicit `-map` and `-f`, absolute paths, and `-xerror` when it decodes, except when it decodes an MP3 (see the amendment below). The source's tags and chapters are dropped. Never `-vn`: it silently drops a mapped cover too.
- **Cover.** yt-dlp's written thumbnail is used if it is a regular file inside the job dir, isn't a placeholder (YouTube's `no_thumbnail`, SoundCloud's `default_avatar` or a user's `/avatars-` photo), and sniffs as JPEG, PNG or WebP. One small pass turns it into a baseline JPEG of at most 1000 px (`mjpeg -q:v 2`, never scaled up). ffmpeg attaches it to M4A and FLAC (`attached_pic`, "Cover (front)"), and our ID3 tag carries it for MP3 and AIFF. WAV, WebM and Ogg get none. A cover failure costs only the artwork.
- **Readback.** The output is probed and must have the planned codec, the title and artist ffmpeg wrote (key case ignored; Ogg keeps them on the stream), the cover when one was planned for M4A or FLAC, and a duration within max(2 s, min(1 %, 10 s)) of the input's. The download's own probed duration must match yt-dlp's `duration` the same way, else the job fails `network` ("incomplete"). An MP3's duration is measured instead of probed (see the amendment below). Every spawn has a timeout: 30 s for a probe or the cover, 60 s to measure, 60 s plus twice the track's length for the audio pass. ffmpeg failing with "No space left on device" is `disk_full`, like a full data drive anywhere else.
- **Honest output** (amends ADR-004). An MP3 source is copied at its own bitrate, so an "MP3" job can be 128 kbps. M4A from a non-AAC source is a transcode to AAC 256 kbps. The Job's `output` (extension, codec, bitrate, sample rate, channels, `encoded`) is read from the written file, never inferred from the format. Its `source` is the stream yt-dlp reported.
- **Names** (`filename.ts` in shared):
  - The template's placeholders are artist, title, album, year, uploader, id and platform. Empty ones leave no stray separators or brackets: `{artist} - {title} ({year})` without a year gives `Artist - Title`.
  - The name is sanitized for macOS, Windows and FAT/exFAT: NFC, controls become spaces, `: ` becomes ` - `, `/ \ | :` become `-`, `"` becomes `'`, `< > ? *` are dropped, reserved Windows names get a `_` prefix, and there is no leading dot. It is cut by grapheme to 180 UTF-16 units (255 in NFD) and to the UTF-8 bytes the folder's real path leaves of macOS's 1,023-byte path (a CJK character is 3 bytes, so 180 units can be 540 bytes), and falls back to `<platform>-<id>`.
  - The extension comes from our muxer table, never from yt-dlp.
  - Artist: the platform's, else split from the title as in resolve, else the uploader without " - Topic". Album and year come only from release fields, never the upload date.

**Amendment (2026-10-03): MP3 sources.** Two failures with valid MP3s from "other" sites (podcast hosts, DJ mixes), reproduced offline with ffmpeg 8.0:
- *Estimated durations.* An MP3 without a Xing/Info header (VBR, or files stitched together) has no length in its header, so ffprobe estimates one from the first frame's bitrate: a 600 s VBR file probed as 2,413 s. Every check failed on it, every retry. Now, when the demuxer is `mp3`, finalize measures the length with one more ffmpeg pass that decodes nothing (`-nostats -progress pipe:1 … -map 0:a:0 -c:a copy -f null -`, the last `out_time_us`; about 150 MB/s) and uses it as the input's duration for the download check, the output check, the WAV/AIFF size guard and the audio pass's timeout. A truncated MP3 (a lost SoundCloud HLS fragment) still measures short and fails `network`. If the report has no time, ffprobe's value stands (logged); a failed or timed-out measuring pass fails like an unreadable download.
- *`-xerror` on stitched MP3s.* Dynamic ad insertion concatenates MP3s, leaving the second file's ID3v2 tag mid-stream. ffmpeg skips it ("Header missing"); `-xerror` makes that fatal (exit 183), so the same file worked as MP3 (a copy) and failed as M4A, FLAC, WAV and AIFF. The audio pass now passes `-xerror` only when the source isn't MP3. The trade-off: junk inside an MP3 is no longer a hard failure, and a small damaged span (under the duration tolerance, e.g. 2 KB) can now pass; a bigger loss is still caught by the output's duration. `-xerror` stays for every other source (a corrupt FLAC decodes to exit 0 without it) and for the cover pass. It never caught truncation anyway (a truncated WebM exits 0 with it).

**Amendment (2026-10-03): no thumbnail for a YouTube original.** `--write-thumbnail` went with every format but WAV, so a YouTube "original" fetched a thumbnail its WebM can't hold. yt-dlp fetches the thumbnail before it picks the stream (before the `START` print) and has no per-format thumbnail option, so the choice is made from the format and the platform alone: `canHoldCover(format, platform)` in `finalize-plan.ts` is false for WAV (from the muxer table) and for `original` on YouTube, whose `ba` was Opus 251 in WebM on every video checked live (yt-dlp 2026.08.19), and true otherwise. SoundCloud's MP3 or AAC original and another site's MP3, M4A or FLAC original keep their cover; another site's WebM or Ogg original still fetches a thumbnail it can't use. Making every original artless would drop the covers SoundCloud originals already get. The trade-off: a YouTube original that comes out AAC (no Opus offered; none seen) is an M4A without a cover.

**Rejected.**
- *`-x` with fixes* (`--postprocessor-args` for 16-bit FLAC and no source tags): the copy-or-encode decision stays where we can't see or report it, there is still no AIFF, and nothing proves the file is whole.
- *Skipping the duration checks for MP3s*: it would drop the truncation backstop for SoundCloud's HLS MP3s, whose CBR estimate is exact.
- *Retrying an MP3 without `-xerror` after a failure*: two encodes for every damaged file, and the duration check judges the result either way.
- *Trusting ffmpeg's exit code*: a truncated download became a 4.8 s MP3 of a 19 s track, with exit 0.

**Consequences.**
- Each job runs two ffprobe calls and one or two ffmpeg passes: about 0.1 s for a copy, about 2 s to encode 5 minutes of MP3.
- The rest of ADR-006 stands: a temp dir per attempt, our finalize owns the final file, and the job dir is removed after every attempt.
- "Original" from YouTube is Opus in WebM, which no DJ app plays and which holds no cover, so it fetches no thumbnail.
- `test/fixtures/ffprobe/` pins the real ffprobe JSON of sources and outputs, and `test/finalize-real-ffmpeg.test.ts` (opt-in) runs the argv against the real ffmpeg.

## ADR-016 — The comment tag holds the track's public page URL; our own ID3v2.3 writer tags MP3 and AIFF
*2026-10-03 · accepted*

**Context.** The product writes the source URL into the comment tag (on by default), where DJ apps show comments. ffmpeg 8 can't write an ID3 `COMM` frame: every comment key (`comment`, `COMM`, `comment-eng`, …) becomes `TXXX:comment`, in v2.3 and v2.4. ffprobe reads both back as `comment`, so only a byte-level check notices. A SoundCloud secret link is a credential, and audio files get shared. yt-dlp's `original_url` is our own input.

**Decision.**
- **MP3 and AIFF.** ffmpeg writes no tags (`-map_metadata -1`, no `-metadata`, and `-id3v2_version 0 -write_id3v1 0` or `-write_id3v2 0`). `engine/id3.ts` (pure) builds the whole tag:
  - frames TIT2, TPE1, TALB, TPE2, TYER, COMM (language `eng`, empty description) and APIC (front cover, `image/jpeg`)
  - text in Latin-1 when every character fits, else UTF-16 with a BOM
  - plain big-endian frame sizes, a syncsafe tag size, no unsynchronisation, and 2 KiB of padding so tag editors can add frames in place
  - MP3: the tag, then ffmpeg's output, streamed into a new file. AIFF: an `ID3 ` chunk (plus a pad byte when its length is odd) appended after the last chunk, and the FORM size rewritten.
- **Other formats** keep ffmpeg's `-metadata comment=…`: M4A `©cmt`, WAV `ICMT`, WebM `COMMENT`. FLAC and Ogg get `DESCRIPTION`, ffmpeg's mapping.
- **Which URL** (`commentUrl` in `finalize-plan.ts`): only yt-dlp's `webpage_url` from the DONE line, never the input URL as a fallback, and only when all of these hold:
  - the classified platform is YouTube or SoundCloud; other sites get no comment;
  - `webpage_url` classifies to that same platform and isn't a secret link;
  - the input URL isn't a secret link or a SoundCloud short link (`on.soundcloud.com`, which may hide one);
  - yt-dlp's `availability` is `public`. YouTube reports it, so an unlisted video gets no comment. SoundCloud reports none for public tracks, so a missing value counts as public there only.
- `sourceUrlComment: false` (a setting and a download option) writes no comment at all.
- Every tag value passes `cleanTagValue`: controls become spaces, whitespace collapses, at most 1,000 characters, and an empty value is left out. The year is four digits.

**Rejected.**
- *`TXXX:comment`*: the URL would be in the file, but DJ apps most likely don't show it.
- *A tag library* (node-taglib-sharp, taglib-wasm, node-id3): a dependency with wasm or native code for five text frames, a comment and a picture.
- *The input URL as a fallback*: it can be a secret or short link.

**Consequences.**
- Whether rekordbox, Serato and Traktor read our COMM frame, the AIFF's trailing `ID3 ` chunk and FLAC's `DESCRIPTION` is unverified (a roadmap item). mutagen and ffprobe read them.
- Tests read our frames with a reader written independently of the writer (`test/id3-reader.ts`), because ffprobe can't tell COMM from TXXX.
- Secret and short SoundCloud links, unlisted YouTube videos and other sites get no comment.

## ADR-017 — Downloads are paced by per-platform gates, with one SoundCloud budget shared with enrichment
*2026-10-03 · accepted · amends ADR-014 and settles its open question on format narrowing*

**Context.** YouTube allows about 300 videos an hour without a login, then answers "This content isn't available, try again later" (`rate_limited`); a session it suspects gets bot checks. SoundCloud allows about 600 API requests per 10 min, and a download costs about as much as an enrichment lookup. ADR-014 paced lookups only. yt-dlp's own sleep flags are silent in quiet mode and know nothing about the other jobs, and its retries of a rate-limited request spend more budget. ADR-014 left SoundCloud format narrowing to Phase 2.

**Decision.**
- **Gates** (`pacing/gates.ts`). The queue asks a platform's gate before it starts a job, takes a token at the start and reports every end. Every decision uses the platform of the classified URL, never the client's `TrackRef.platform`.
- **Buckets** (`pacing/token-bucket.ts`, the GCRA bucket moved out of the limiter):
  - YouTube: a burst of 10 downloads, then one per 12 s (about 300 an hour).
  - SoundCloud: **one** bucket shared with enrichment (`SOUNDCLOUD_LOOKUP_BUDGET`, a burst of 25 refilling one per 5 s). Downloads leave its last 5 tokens to lookups, so rows in view still fill during a long set download.
  - Other sites: no bucket, only the cooldown.
- **Cooldown** on a `rate_limited` failure (any platform) or a YouTube `bot_check`:
  - *strike*: the job started after the last cooldown ended. The platform pauses for 60 s, doubling per consecutive strike up to 10 min.
  - *inside*: the job started before the pause ended, so it belongs to that pause and adds no strike.
  - Either way the job goes back to the **front** of its platform's queue with `lastError` instead of failing. A job that itself caused 3 strikes fails with its last error.
  - Strikes reset only on a success that started after the last cooldown ended.
  - *half-open*: after a pause, one job of the platform runs at a time until one succeeds.
  - *blocked*: a bot check that reaches the 10-min cooldown twice in a row is persistent, so every queued YouTube job fails with it. A rate limit never fails the queue.
- `queue.updated` reports each platform's `pausedUntil` and `pauseCode`, and `nextStartAt` for paced starts, rounded up to whole seconds.
- **yt-dlp's part.** No `--sleep-*` flags. Retries are bounded (`--retries 3 --fragment-retries 3 --retry-sleep fragment:exp=1:8 --socket-timeout 20`), and SoundCloud adds `--extractor-retries 0`, so a 429 fails at once and the cooldown takes over (`1` would still retry once).
- **No SoundCloud format narrowing** (settles ADR-014). Downloads keep the default formats. The selectors are `ba[acodec!=opus]/ba` on SoundCloud (its 64k Opus only when nothing else exists), `ba` on YouTube and `ba/b` plus `--match-filters "!is_live"` elsewhere; M4A tries `ba[ext=m4a]` first. Resolve's `audioSource` skips SoundCloud's Opus the same way, so the source shown matches the download.
- **Cooldowns aren't shared** with the enricher yet: a 429 pauses only the side that saw it.

**Rejected.**
- *yt-dlp's throttles* (`--sleep-requests`, `--sleep-interval`, `--retry-sleep extractor:…`): silent in quiet mode, per process, and blind to the queue.
- *`--extractor-args soundcloud:formats=…`*: a track without the chosen formats fails with "No video formats found!", and the source shown at resolve would drift from the download.
- *Failing jobs on a rate limit*: the limit lifts by itself, and a requeue at the front keeps the batch's order.

**Consequences.**
- A long YouTube batch runs at about 300 an hour after the first 10. A SoundCloud set download gets 20 of the 25-token burst, then shares one token per 5 s with enrichment.
- `--max-filesize 2G` is enforced only by the plain HTTP downloader; HLS ignores it.
- There is no stall timer: retry sleeps and forced waits print nothing in quiet mode, so one would have to ignore them (a roadmap follow-up). The socket timeout bounds each request.
- Pacing state lives in memory and starts fresh with each server.

## ADR-018 — One server holds the app data dir and sweeps what a previous one left; publishing never overwrites
*2026-10-03 · accepted · details ADR-006's job dirs and move · amended by ADR-024 (folders checked when chosen)*

**Context.** Engine processes run in their own process groups (ADR-006), so they survive a crashed or SIGKILLed server and keep writing into its job dirs. A cross-volume copy can leave a part file in the user's folder. Two servers on one data dir (a `node --watch` restart overlapping the old server's shutdown, a second `pnpm start`) would kill each other's jobs if each swept at startup. On macOS, `rename` replaces an existing file silently, also when only the case or Unicode form of its name differs (APFS, exFAT), and FAT/exFAT have no hard links. The user's folder can be renamed or unplugged while a batch runs.

**Decision.**
- **Data dir.** `~/Library/Application Support/DJ Scraper`, or `DJS_DATA_DIR`. It and its `jobs/` must be real directories owned by the user (never symlinks), created 0700. Downloads may not go inside it.
- **Lock.** At boot, right after the data dir is prepared and before the sweep or the settings touch it, `server.lock` is opened with `O_EXLOCK | O_NONBLOCK | O_NOFOLLOW` (macOS takes an exclusive flock with `open(2)`; a symlink there fails instead of having its target rewritten), and the numeric fd is kept for the process's life. Children don't inherit it, because libuv opens files with `O_CLOEXEC`. The file records `{ pid, startedAt, port }`.
  - A second server polls for up to 9 s ("Waiting for the previous server … to stop"), then exits 1 naming the holder's pid and URL.
  - Off macOS, or on a filesystem without flock (ENOTSUP), the server warns and runs without the lock and without the sweep.
  - Shutdown releases the lock last.
- **Sweep** (lock held, before listening):
  1. One `ps -A -ww -o pid=,pgid=,command=`.
  2. SIGKILL every process group but ours with a member whose argv names `<real data dir>/jobs/<uuid>`: yt-dlp's `-P`, and every ffmpeg path.
  3. Wait up to 2 s for those groups to go.
  4. Unlink the part files that part records name. A record whose part's folder is missing (a drive not plugged in) is kept for a later start, for up to 30 days.
  5. Remove the `jobs/` entries named `<uuid>` or `<uuid>.part.json`, except the records kept in step 4. Nothing else in `jobs/` is touched, and no symlink is followed.
- `run.ts` SIGKILLs a run's whole group whenever it closes, so a yt-dlp that died abnormally can't leave its ffmpeg writing.
- **Folders.** At enqueue the folder must be an existing, writable directory outside the data dir; only the default `~/Music/DJ Scraper` is created. A subfolder is one sanitized name, created if missing, and may not be a symlink, even to a folder beside it. Right before publishing the folder is resolved again (`realpath`). It must be the same real path and still a directory, else the job fails `folder_unavailable`, and so does every queued job for that folder. Publishing never creates it.
- **Publishing** (`fs/move.ts`), one name claim at a time in the process:
  - Same volume: `link(src, dest)`. EEXIST means a file of that name is there (case- and normalization-insensitively), so the job ends `skipped` and the user's file is untouched.
  - Another volume, or no hard links (EXDEV, ENOTSUP, EPERM, EMLINK): write `jobs/<attemptId>.part.json`, copy (abortably) to `<folder>/.djs-<attemptId>.part` and fsync, then `link(part, dest)`. Where hard links fail (FAT/exFAT, SMB), reserve the name with an exclusive create and rename the part onto our own empty placeholder. Our `._` sidecar is removed only if we made it.
  - Any error or abort removes the part and our placeholder. The part record stays when the part can't be removed or its folder is gone with it (renamed, a drive unplugged). The claim itself is the one step a cancel doesn't stop: a file that reached the folder stands, as done or skipped. Waiting for the turn to claim, and the folder check before it, stop on a cancel.
  - Whether a file exists is decided by the filesystem, never by comparing names.

**Rejected.**
- *Per-spawn run records* (a pgid and start time per job, matched against `ps`): writes on every spawn and PID reuse to guard against, while the job-dir marker in argv already identifies our processes once the lock rules out a live owner.
- *`rename` into the folder*: it overwrites silently, even a case variant on exFAT.
- *A pid file without a lock*: a stale pid can be reused, and two servers could each think the dir is theirs.
- *`dot_clean`*: it removes the user's own sidecars too.

**Consequences.**
- A `node --watch` restart waits for the old server's shutdown (at most 8 s) instead of failing.
- After a crash, the next start kills the orphans, empties `jobs/` and logs one summary line.
- A file of the same name in any case or Unicode form means `skipped`: a different filename template is how to keep both.
- `DJS_DATA_DIR` may name a folder of the user's; its permissions change only once it holds `server.lock`.

## ADR-019 — Downloads reach the web over one SSE stream that starts with a snapshot
*2026-10-03 · accepted*

**Context.** The downloads panel needs every job's state live, across reconnects and server restarts, and the engine chip must notice when the server is gone. Fetching `GET /api/downloads` and then subscribing races: an event between the two is lost or applied twice. Browsers deliver SSE comments to no script, allow 6 connections per host, and reconnect an EventSource on their own. Vite's dev proxy (http-proxy-3) never ends the browser's response when the server dies mid-stream, so the EventSource hangs without an error.

**Decision.**
- **Server** (`routes/events.ts`):
  - The first write is a raw `retry: 1000`. Then comes a `snapshot` (`serverId`, jobs in creation order, batches, queue state), taken in the same tick as the bus subscription so no event falls between them, and then every event in order.
  - Each event is serialized once at the bus (`jobs/bus.ts`), and checked against `ServerEventSchema` in dev and in tests.
  - A typed `{ type: 'heartbeat' }` goes out every 15 s.
  - A bulk change is one `jobs.added`, `jobs.updated` or `jobs.removed`.
  - No progress throttle: `--progress-delta 0.5` already limits DL lines to about two a second per job, and each becomes one `job.progress`.
  - Each stream writes through its own chain. One whose pending writes, its largest one aside, pass 16 MiB is cut off and resyncs from the snapshot when it reconnects; so one big snapshot or bulk event always reaches a client that reads. At most 32 streams are open (503 after that). HEAD gets the headers only, never a stream.
  - Shutdown ends every stream cleanly before the server closes, so the browser (and Vite's proxy) sees the end; new streams get 503 from then on.
- **Web** (`lib/events.ts`, started once in `main.tsx`, outside React):
  - The stream is the only writer of `['downloads']` (`DownloadsState`: connection, serverId, order, jobs by id, batches, queue). That query never fetches (`skipToken`, infinite stale and gc time), and mutation answers aren't written into it.
  - A snapshot replaces the state. Updates before the first snapshot, invalid updates and updates for unknown jobs are dropped. Three invalid snapshots in a row stop the retries (`down`).
  - A drop that lasts over 2 s invalidates `['health']`, so the engine chip says "Server offline". Reopening after such an outage invalidates it again.
  - A closed stream reconnects after 1 s, doubling to 10 s. A watchdog checks every 5 s and replaces a stream that has been silent for 45 s (three heartbeats).
  - A tab hidden for 10 s closes its stream, giving the connection back, and reopens it when shown.
- **Vite proxy fix.** The `/api` proxy's `configure` destroys the browser's response when the server's response closes incomplete. `vite-config.test.ts` pins it.

**Rejected.**
- *Fetch, then subscribe* (or refetch on reconnect): it races, and the snapshot event does the same job in order.
- *Comment heartbeats* (`: ping`): page scripts never see them, and the watchdog must.
- *A server-side progress throttle* (the earlier "about 4 events/s per job" rule): `--progress-delta` already limits the lines, and a forced wait is an instant (`waitingUntil`), not a ticking counter.
- *Polling* the jobs list.

**Consequences.**
- `GET /api/downloads` exists for tests and tools; the web never calls it.
- Each tab holds one connection for its lifetime, except while hidden.
- Chromium logs its own console error for a failed `/api/events` request (a 404, or the proxy's 502), which the e2e console guard counts.
- A short download may send a single `job.progress` before it switches to processing. There is no guaranteed 100 % event.

## ADR-020 — The web UI: one page beside an always-visible downloads panel, a resolve per paste, auto-download from the track card
*2026-10-03 · accepted*

**Context.** Phase 3 builds the UI on the Phase 2 API (product.md, flows 1–5). A paste must answer fast and stay cancelable (a big list takes up to a minute), a single track downloads at once by default, and progress must stay in view while the next link is pasted. Things change under a mounted view: settings arrive late or change, a job's `jobs.added` lands after the create request has answered, and a job can leave the list (Clear finished, eviction, a server restart).

**Decision.**
- **Shell** (`routes/__root.tsx`): a header with the target folder (`FolderPicker`) and the engine chip, the `EngineBanner` under it (only when something is wrong), then the page (`<main>`) and the downloads (`<aside aria-label="Downloads">`). On lg+ the shell is the window's height, the panel is 24 rem wide on the right, and each column scrolls on its own; below lg they stack and the page scrolls. There is one route, `/`.
- **Resolve** (`features/resolve/use-resolve.ts`): a `useMutation`, never a query. Each load gets its own AbortController, passed in the mutation's variables; a new load aborts the running one, and so do Cancel, Esc in the link box and leaving the page. No retries. Every load has a number, and the result view is keyed by it, so each paste mounts a fresh track card or collection. While a resolve runs, a skeleton replaces the last result. Every way in loads through the link box, Try again and the list fallback of a failed resolve too, so the box always shows the link being loaded (normalized). A refused load (text that isn't a link, a DRM service; pasted, dropped or typed) leaves a running resolve and a shown result alone, but clears a previous error, whose Try again would load the old link under the refused text.
- **Track inside a list:** "This track" shows the track already in the `ambiguous` answer, with no second resolve; the list resolves `collectionUrl` with `mode: 'collection'`. A mix defaults to the track. When the track lookup fails in auto mode, the error still offers the list ("Open the playlist", album or mix).
- **Auto-download** happens in the track card (`useTrackDownload`). Its `autoStart` is `settings.autoDownloadSingles` for a track that isn't unavailable, read once settings have loaded and frozen at mount; a ref keeps StrictMode to one request. The card then shows the job: "Queued…" until `jobs.added` arrives, the job's own `source` once it reports one, and "Download again" when a retry can't help, when a job it has seen leaves the list, or beside Retry when the job lost its folder (`folder_unavailable`: Retry keeps the job's folder, Download again uses the header's). After Download, Try again or Download again, focus moves to the card's download area (`data-slot="track-download"`), so Tab goes on to the job's action; an auto-start moves no focus.
- **One action per job** (`job-actions.ts`): Cancel while queued or running, Retry for a canceled job or a failure `isRetryableError` allows, Reveal in Finder once done or skipped. It is one button whose action changes with the job, so keyboard focus stays on it.
- **Settings** (`useUpdateSettings`) are optimistic: the change shows at once, the server's answer replaces it, and a failure puts the old value back and refetches, unless another update is still saving. Updates are sent one at a time, in the order they were made (mutation scope `settings`): a later one shows at once and waits for the earlier answer, which keeps the waiting changes on top. The server applies `PUT /api/settings` in arrival order too, so a slow folder check can't let an older folder be saved last.
- **Downloads data:** components read `['downloads']` through `useDownloads`, `useJob`, `useJobIdsByTrack` and `useQueue`, which select what they need, so one job's progress re-renders only what shows that job (a collection row's chip reads its job by id). Mutation answers never go into it (ADR-019).
- **Network mode:** every query and mutation runs with `networkMode: 'always'` (`lib/query-client.ts`). The API is on 127.0.0.1, so the browser's online state says nothing about reaching it, and TanStack's default would pause a settings change, a folder pick or a resolve while Wi-Fi is off.

**Rejected.**
- *A query keyed by the URL* for resolve: pasting the same link again must resolve again, and an answer is never shared or cached.
- *Keeping the last result visible during a new resolve*: a skeleton is clearer, and the downloads panel keeps the history.
- *An `autoStart` that follows the setting*: settings that arrive late (after an error) or change later must not start a download the user has been looking at.
- *A downloads page* (the `routes/downloads.tsx` of the earlier layout): progress would leave the screen whenever the next link is pasted.

**Consequences.**
- Pasting a track twice queues it twice: the server maps the second to a job still running for the same folder and format, or it ends `skipped` at publish.
- A track card shows a skeleton until settings have loaded. The header's folder picker loads them anyway.
- There is no settings page yet: the format is set beside the track card's Download button and in the download bar, the subfolder switch in the download bar, the folder in the header (Phase 4 adds the page).

## ADR-021 — Long lists: fixed-height virtualized rows, a div table with ARIA roles, a selection keyed by track
*2026-10-03 · accepted*

**Context.** A collection holds up to 5,000 rows (product.md: smooth with 1,000+), the downloads panel can hold thousands of jobs, and every running job sends about two progress events a second. A playlist can list one video twice, partial rows change as they fill in, and enrichment can find a selected row unavailable.

**Decision.**
- **Virtualization** with TanStack Virtual (`@tanstack/react-virtual`) and fixed row heights, so nothing is measured: collection rows are 44 px, the panel's batch headers and job rows 56 px, with an overscan of 8. Rows are memoized, and an unchanged row keeps its identity, so an update re-renders only the rows it touches; a download's progress re-renders only its row's status chip.
- **Collection table** (`track-table.tsx`, `track-row.tsx`): divs with ARIA table roles (table, rowgroup, row, columnheader, cell), because the virtualized rows are absolutely positioned. The table is one Tab stop with roving focus: arrow keys, Page Up/Down, Home and End move between rows and scroll the virtualizer. A click anywhere on a row toggles it, shift-click sets the range from the last clicked row in the filtered order, and Space toggles the focused row's checkbox.
- **Downloads panel** (`panel-list.tsx`): one virtualized `<ul>` of batch headers and job rows (`aria-setsize`, `aria-posinset`), newest batch first, each batch's jobs in creation order. The scroller isn't focusable; keyboard users reach rows through their buttons.
- **Selection** (`selection.ts`, a pure reducer; `use-selection.ts`): a `Set` of `TrackKey`s (`platform:id`) plus the shift-click anchor. Every row that isn't unavailable starts selected, partial and `unknown` ones included. All, none and invert act on the rows the filter shows, and the filter keeps the selection. A row that can't be selected never enters it, and leaves it when enrichment finds it unavailable. Duplicate rows share one key, so they share one state and are sent once; React keys are row indexes.
- **Download** sends the selected rows in table order, those the filter hides included, as `toTrackRef` of the enriched row.
- `CollectionView` is keyed by the collection object (`instance-key.ts`), so a new resolve, even of the same URL, starts the selection, filter and enrichment over.

**Rejected.**
- *`<table>` elements*: absolutely positioned rows don't fit a table's layout.
- *A focusable `role="list"` scroller* for the panel: Biome's `noNoninteractiveTabindex` and `useSemanticElements` refuse it.
- *A selection by row*: a video a playlist lists twice would download twice.

**Consequences.**
- About 30 rows are in the DOM at 5,000 rows or jobs. Select all, invert or a filter keystroke took about 10 ms there in Phase 3's browser pass.
- A focused row that scrolls far away unmounts and loses focus, the usual cost of virtualization.
- `track-table.tsx` and `track-row.tsx` suppress Biome's `useSemanticElements` and `useFocusableInteractive`, with that reason.
- jsdom lays nothing out, so tests stub the scroller's `offsetHeight` and `offsetWidth` (`stubTableViewport` in `features/collection/test-utils.ts`, and the panel's own test).

## ADR-022 — The web fills partial rows from a session outside TanStack Query
*2026-10-03 · accepted · the web side of ADR-014*

**Context.** ADR-014 paces lookups on the server and leaves the client to show placeholders and to cancel requests for rows that scroll away. Which rows to ask for depends on the scroll position, each request needs an AbortController a scroll can trigger, and one list holds rows that are in flight, pending, failed or filled at once.

**Decision.** `useEnrichment(entries)` (`features/collection/use-enrichment.ts`) is a thin binding over a session without React (`enrich-session.ts`, with the pure `enrich-plan.ts`, `enrich-merge.ts` and `enrich-retry.ts`): one session per `entries` array, read with `useSyncExternalStore`, started in an effect and stopped in its cleanup.
- **Which rows:** each partial track gets one lookup, shared by duplicate rows. The rows in view are the rows the table shows (the filter applied), as collection indexes: the visible ones top-down, then the next 5 shown rows below and the 5 above, nearest first (`rowsInView` in `rows.ts`; the table reports them through `onRowsInViewChange` to `setRowsInView`). A row the filter hides is never looked up, even between two shown rows. Until the table reports, the first 15 rows count as visible.
- **When:** 150 ms after the rows in view last changed, so a fast scroll asks for nothing it passes. A request holds 4 rows (`ENRICH_BATCH_SIZE`), at most 2 run at once, and the next goes out as one answers, so rows fill in a few at a time while the server paces them. `MAX_ENTRIES_PER_REQUEST` (25) is only the server's cap.
- **Scrolled away:** a request is aborted as soon as none of its rows is in the range plus overscan. Its rows go back to pending, silently.
- **Merging** is by platform + id. `ok` replaces the row with the full Track (`partial: false`), keeping the row's own platform and id, so selection keys and job chips don't change. An unavailable-type code (`unavailable`, `private`, `geo_blocked`, `age_restricted`, `login_required`, `preview_only`) marks the row unavailable with that reason. `rate_limited`, `network`, `unknown` and `canceled` fail the row, which is asked for again while it is in view: 30 s later, then after 1, 2, 4 and 8 min, then at most every 10 min (or when it scrolls back into view after that time). Any other code fails it for good. While the tab is hidden no retry or back-off timer is set; showing the tab plans again (`visibilitychange`). A row the answer leaves out fails like `unknown`, and a row whose URL is over `MAX_URL_LENGTH` fails at once.
- **Whole request:** unreachable, a 5xx or a 429 sends its rows back to pending and backs off 2 s, doubling to 30 s. Requests that fail in the same outage share one back-off, and a successful request resets it and clears a pending one. Any other 4xx, or an answer off the contract, fails the batch's rows with that error; an answer off the contract counts as `unknown`, so its rows are asked again like any `unknown` row. Timing uses a monotonic clock (`performance.now`), like the server's limiter, so a wall-clock change can't stall it.
- Only changed rows get new objects. Unmounting aborts every request and clears every timer, and a list without partial rows sets no timer and never re-renders on scroll.
- **Nothing is cached in the browser.** Resolving the collection again asks again; the server's 30 min cache answers without spending SoundCloud's budget.

**Rejected.**
- *A TanStack query or mutation per batch*: batches follow the scroll and are aborted by it, and there is nothing to cache by key.
- *Backing off on every failure*: a 4xx or a contract break would fail the same way forever.

**Consequences.**
- A failed row says "Couldn't load details" and stays selected and downloadable. Its job is named after its platform and id ("SoundCloud track 47127625") until the download's metadata arrives.
- The collection's component tests replace `useEnrichment` with a stand-in (`useFakeEnrichment` in `features/collection/test-utils.ts`, through `vi.mock`); the hook has its own tests with fake timers, and `collection-enrichment.test.tsx` runs the real hook under the real table (no `vi.mock`, real timers).

## ADR-023 — A collection links the lists its page shows instead of tracks (`Collection.lists`)
*2026-10-03 · accepted · amends ADR-013*

**Context.** A SoundCloud user's `/sets` and `/albums` tabs list only sets, so they resolved to empty collections that said only how many rows were skipped (`skippedEntries`), and a user page mixes sets in with its tracks. A YouTube channel's Playlists tab lists playlists the same way. The flat listing already gives each such row its URL.

**Decision.**
- `Collection` gains `lists?: CollectionLink[]` (`{ url, title? }`, at least one when present): the rows the listing skips, within the entry cap, whose URL classifies as a collection. They keep the listing's order, appear once per URL, never link back to the page itself, and carry a title only when it has text. A secret set's URL is kept whole, as a row's is. `skippedEntries` still counts every skipped row.
- The rule is generic, not SoundCloud's (`toListLink` in `engine/ytdlp-parse.ts`): rows that are tracks, other sites, DRM services or URLs with credentials are counted but not linked.
- The web calls them what the page does ("sets", "albums", "playlists") and opens one by resolving its URL in auto mode. A page with lists and no tracks shows the lists as its content; beside tracks, a header note links them.

**Consequences.**
- One more recorded fixture, `soundcloud/user-albums.json` (30 `-J` fixtures in all).
- A secret set's link reaches the browser like any secret row URL, and is never logged.

## ADR-024 — A download folder is checked and read when it is chosen
*2026-10-03 · accepted · amends ADR-018*

**Context.** ADR-018 checks the folder at enqueue and again before publishing. On macOS, the first read inside a protected folder (Desktop, Documents, Downloads, iCloud Drive, a removable or network volume) brings up a privacy prompt; with only those checks it appeared when a batch published its first file, and a refusal failed jobs then. A folder chosen from the recent folders wasn't checked at all, so a deleted one was accepted and failed only at the next download, against "a folder you name must exist" (product.md).

**Decision.**
- `checkPickedFolder` (`fs/folders.ts`) makes enqueue's checks (`resolveTargetFolder`: an existing, writable folder outside the data dir, with room for the longest file name), then reads one entry of the folder's real path. It never creates anything.
- It runs when a folder is chosen: after the native picker returns a path (`POST /api/folders/pick`), and when `PUT /api/settings` changes `folder`, e.g. to a recent one. The answer waits for the read, and so for the user's answer to the prompt.
- Every refusal is 422 `folder_unavailable` with enqueue's wording; what enqueue calls `invalid_request` (a path too long for the file names) is `folder_unavailable` here, since the folder is the problem. A privacy refusal (EPERM) names System Settings › Privacy & Security. A refused PUT saves nothing of the request.
- Exceptions: EACCES on the read alone is accepted, since a write-only drop box still takes downloads (publishing never lists the folder); the default `~/Music/DJ Scraper` is accepted while missing, since its first download creates it; an unchanged `folder` isn't checked again, so other settings still save while its drive is out.

**Rejected.** *Refusing a folder that can't be listed*: choosing a folder would be stricter than enqueue and publish.

**Consequences.**
- The picker's one-at-a-time lock (409) covers the dialog only, not the prompt after it: a second pick sent during the prompt opens a new dialog.
- Access revoked after a folder was chosen is still found only at publish, job by job (a roadmap follow-up reads the folder at enqueue too).
- Tests script the filesystem (`FolderOps.opendir`); a real prompt hasn't been checked live yet.

## ADR-025 — Finished jobs are evicted canceled first, and a batch being canceled isn't spared
*2026-10-03 · accepted (chosen by the assistant; easy to change)*

**Context.** The server keeps at most 2,000 finished jobs (Phase 2). Beyond that it dropped the oldest done, skipped and canceled jobs before failed ones, and spared every batch that still had a job to run. In Phase 3's browser pass, canceling a 4,976-row batch evicted about 20 done jobs of older batches, whose track cards then said "No longer in the downloads list". Two causes: done and canceled jobs were one group, oldest first, so older batches' done jobs went before the new canceled ones; and the big batch's running jobs were only being canceled (`cancelRequested`), so the rule spared all of its canceled jobs.

**Decision** (`EVICTION_ORDER` in `jobs/queue.ts`). Canceled jobs go first, except the 50 that finished most recently (`recentCanceled`, `DEFAULT_RECENT_CANCELED`); then done and skipped ones; then failed ones together with those 50 recently canceled ones (a retry may still want them). Oldest first within each group. A batch is spared only while it has a job to run that isn't being canceled.

**Consequences.**
- Canceling a big batch drops its own canceled jobs (all but its newest 50) before other batches' finished ones: in the case above, the done and failed jobs stay. Other batches' done jobs go only once more than about 1,950 finished jobs that aren't canceled are already kept.
- A track the user just canceled keeps its Canceled row and its Retry at the cap; the oldest done or skipped record goes instead.
- Once no older canceled job is left to drop, a done job's record (never its file) still goes before a failed one.
- No e2e covers it, since it needs more than 2,000 finished jobs on the shared e2e server; `queue.test.ts` does.
