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
