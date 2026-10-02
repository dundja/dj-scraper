# DJ Scraper

A local web app for DJs. Paste a YouTube or SoundCloud link (track or playlist), review the metadata, pick tracks, and download them as DJ-ready audio files into a folder you choose. It runs only on this machine: a Vite/React UI at localhost plus a Node server that drives yt-dlp and ffmpeg.

**Status:** scaffolding (roadmap Phase 0). The root workspace, `packages/shared`, `apps/server` (health, guard, engine spawn wrapper) and `apps/web` (dark shell with live engine status) exist, and `pnpm dev` runs both apps. Still to come: `pnpm start` serving the built UI, and Playwright. The current phase and next items are in `docs/roadmap.md`.

## Where things are explained
| Need | Read |
|---|---|
| What to build, user flows, non-goals | `docs/product.md` |
| Modules, API, domain model, security, testing | `docs/architecture.md` |
| Why it's built this way (ADRs); don't silently re-litigate | `docs/decisions.md` |
| What's next | `docs/roadmap.md` |
| yt-dlp/ffmpeg flags, output parsing, platform quirks | `ytdlp` skill (`.claude/skills/ytdlp/`) |
| Package conventions | `apps/web/CLAUDE.md`, `apps/server/CLAUDE.md`, `packages/shared/CLAUDE.md` |

## Stack
- pnpm 12 workspaces · Node 24 LTS · TypeScript 7 (strict, ESM, typecheck only)
- `apps/web`: Vite 8, React 19, TanStack Router + Query, Tailwind CSS v4, shadcn/ui on Base UI
- `apps/server`: Hono on Node (`127.0.0.1:4747`), SSE for live progress
- `packages/shared`: Zod schemas = the API contract
- Engine: yt-dlp + ffmpeg/ffprobe as child processes (installed via Homebrew in dev)
- Tooling: Biome (lint + format), Vitest, Playwright
- TypeScript must run as is under Vite, Vitest and Node's type stripping. Use `.ts` in relative imports and `import type` for types; no enums, namespaces or parameter properties. See `docs/architecture.md` > Workspace & tooling.

## Commands
These scripts are created in roadmap Phase 0. Keep this list true.
```
pnpm dev          # web on :5173 (proxies /api) + server on :4747
pnpm build        # build all packages
pnpm start        # production: server serves the built UI on :4747 (serving the UI is not built yet)
pnpm check        # Biome lint + format check (check:fix applies fixes)
pnpm typecheck    # tsc across the workspace
pnpm test         # Vitest unit + integration, no network
pnpm test:e2e     # Playwright against the fake engine (not set up yet)
pnpm smoke '<url>' # live resolve against real YouTube/SoundCloud (network)
```
To scope a script to one package: `pnpm --filter @dj-scraper/<web|server|shared> <script>`. Biome is scoped by path instead: `pnpm check apps/web`.

## Layout
```
./                 package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json
apps/web/          React SPA
apps/server/       Hono API, download queue, yt-dlp/ffmpeg engine
packages/shared/   Zod schemas + pure helpers used by both
docs/              product, architecture, decisions, roadmap
.claude/           agents, skills, hooks, settings
```

## Non-negotiables
1. **No shell for user input.** yt-dlp and ffmpeg run only through `apps/server/src/engine/run.ts`: argv array, `shell: false`, `--ignore-config`, URL after `--`.
2. **Files go only where the user said.** Resolve every output path and assert it is inside the chosen folder. Sanitize filenames. Never overwrite silently.
3. **The local server is not public.** Bind `127.0.0.1`. Keep the Host/Origin guard and JSON-only mutations on every route. No CORS headers.
4. **One contract.** Every API and SSE shape is a Zod schema in `packages/shared`, and both sides change together. No `any`.
5. **Tests stay offline.** Unit, integration and e2e tests use recorded fixtures and the fake engine. Only `pnpm smoke` goes live.
6. **Honest audio.** Show the source codec and bitrate. Never present an upconverted file as higher quality. No Opus/WebM in final files unless the user picks "original".
7. **No DRM circumvention.** Spotify, Apple Music, Tidal, Deezer and Beatport streams are out of scope, and so is bypassing paywalls or private content.

## How to work here
- Start from the roadmap item and read the relevant doc sections before coding. Ask when a request conflicts with `docs/decisions.md`.
- Work in small steps that keep the build green, and run the `verify` skill before saying you're done.
- Delegate to the project agents:
  - `ytdlp-specialist` for the engine
  - `ui-engineer` for UI work and browser checks through the Playwright MCP
  - `test-engineer` for tests and fixtures
  - `code-reviewer` before you finish a feature
- `/implement [item]` runs the full plan → build → verify → review → docs loop. `/smoke-test [url]` checks the engine against live platforms.
- After a change, tick the roadmap item, keep `docs/` and this file accurate, and add an ADR for any new decision.
- Commit only when asked. Use Conventional Commits (`feat(server): …`, `fix(web): …`), one logical change per commit.
- Hooks: every edited file is formatted with Biome, and each session starts with the current roadmap phase.

## Engine gotchas
The full playbook is in the `ytdlp` skill.
- yt-dlp breaks when YouTube changes. Suspect an outdated yt-dlp first (`brew upgrade yt-dlp`, or a nightly build via `YTDLP_PATH`).
- YouTube needs a JS runtime. Brew's yt-dlp brings deno, and we also pass `--js-runtimes node:<process.execPath>`.
- `--audio-quality` defaults to ~130 kbps VBR, so MP3 320 needs `--audio-quality 320K`.
- `-x` can't produce AIFF, and `--embed-thumbnail` fails on WAV and AIFF. Our finalize step handles AIFF and artwork.
- `--print` implies `--quiet`, so without `--progress` there is no progress output.
- Cancel with SIGINT to the process group (spawned `detached`). SIGTERM can orphan ffmpeg.
- `--flat-playlist` entries of SoundCloud sets are bare (id + url). Enrich them lazily within SoundCloud's ~600 requests/10 min budget.
- `watch?v=…&list=…` defaults to the whole playlist, so we ask. `list=RD…` mixes never end, so we cap them.
- SoundCloud originals need the uploader's permission and a login. Go+ tracks without a subscription are 30-second previews (`preview_only`).
- No DJ app plays Opus. YouTube's AAC stream (format 140) can be kept as M4A without re-encoding.
