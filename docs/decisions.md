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
