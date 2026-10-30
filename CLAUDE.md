# DJ Scraper

A local web app for DJs. Paste a YouTube, SoundCloud or Spotify link (track or playlist), review the metadata, pick tracks, and download them as DJ-ready audio files into a folder you choose. Spotify links are track lists only: each track's audio is matched and downloaded on YouTube (ADR-026). It runs only on this machine: a Vite/React UI at localhost plus a Node server that drives yt-dlp and ffmpeg.

**Status:** Phases 0–3 are done.
- Phase 0 (scaffold): `packages/shared` (the contract), `apps/server` (guard, engine health, spawn wrapper, serving the built UI) and `apps/web` (dark shell with live engine status), with `pnpm dev`, `pnpm start` and Vitest/Playwright tests.
- Phase 1 (engine & resolve): `classifyUrl`, `POST /api/resolve`, `POST /api/resolve/entries`, the fake engine and `pnpm smoke`.
- Phase 2 (download pipeline): the paced download queue, finalize (one ffmpeg pass plus our ID3 writer, every file read back), publishing that never overwrites, the data-dir lock and startup sweep, settings, the folder picker, reveal and `GET /api/events`, with typed web client calls and one event stream feeding `['downloads']`.
- Phase 3 (UI): paste, drop or type a link (instant badge, a cancelable resolve per paste); the track card auto-downloads; the collection view (virtualized table, selection, filter, SoundCloud rows filled in as they scroll into view, `Collection.lists` to open) with its download bar; the downloads panel beside the page; the header's folder picker (folders checked and read when chosen) and the format select; the engine banner; Playwright e2e of both flows on the fake engine (ADR-020 to ADR-025).

Phase 4 (DJ polish) is under way: remix rows can be played in the app with a speed grid (ADR-029); Spotify links as track lists, matched on YouTube, are in (ADR-026), and so are remix suggestions under a pasted track, searched on YouTube and SoundCloud (ADR-027), pasted Spotify track links as one list past the embed page's 100 rows (ADR-028), and "Hide downloaded" in the track table. Phase 3's follow-ups are at its end. The current phase and next items are in `docs/roadmap.md`.

## Where things are explained
| Need | Read |
|---|---|
| What to build, user flows, non-goals | `docs/product.md` |
| Modules, API, domain model, security, testing | `docs/architecture.md` |
| Why it's built this way (ADRs); don't silently re-litigate | `docs/decisions.md` |
| The visual system: tokens, type, state colours, rules (ADR-030) | `apps/web/DESIGN.md`; product truth for design work in `PRODUCT.md` |
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
pnpm build        # build the web UI (the server runs from source, ADR-009)
pnpm start        # production: builds the UI, then the server serves it on :4747 and opens the browser
pnpm check        # Biome lint + format check (check:fix applies fixes)
pnpm typecheck    # tsc across the workspace
pnpm test         # Vitest unit + integration, no network
pnpm test:e2e     # build the UI + Playwright (Chromium, WebKit) against the fake engine, port 4849
pnpm test:e2e:install # download the Playwright browsers once (network)
pnpm smoke ['<url>' …] # live resolve against real YouTube/SoundCloud (network); no URL = sample set, --entries N, --mode, --json
pnpm smoke --download [--format f]… [--keep] [--bare] ['<url>' …] # live download through the real pipeline into a temp dir, files read back
pnpm smoke --remixes [--json] ['<title>' '<artist>' | '<track url>' …] # live remix suggestions (ADR-027); no argument = Moby – Porcelain, RÜFÜS DU SOL – Innerbloom
```
To scope a script to one package: `pnpm --filter @dj-scraper/<web|server|shared> <script>`. Biome is scoped by path instead: `pnpm check apps/web`.

## Layout
```
./                 package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json
apps/web/          React SPA
apps/server/       Hono API, resolve, download queue and pacing, yt-dlp/ffmpeg engine, finalize, settings, Spotify reader + YouTube matching, remix suggestions
packages/shared/   Zod schemas + pure helpers used by both
docs/              product, architecture, decisions, roadmap
.claude/           agents, skills, hooks, settings
```

## Non-negotiables
1. **No shell for user input.** yt-dlp and ffmpeg run only through `apps/server/src/engine/run.ts`: argv array, `shell: false`, `--ignore-config`, URL after `--`.
2. **Files go only where the user said.** Resolve every output path and assert it is inside the chosen folder. Sanitize filenames. Never overwrite silently. The one exception is the server's own preview cache in its data dir (ADR-029): streams fetched to be played, never published.
3. **The local server is not public.** Bind `127.0.0.1`. Keep the Host/Origin guard and JSON-only mutations on every route. No CORS headers.
4. **One contract.** Every API and SSE shape is a Zod schema in `packages/shared`, and both sides change together. No `any`.
5. **Tests stay offline.** Unit, integration and e2e tests use recorded fixtures and the fake engine. Only `pnpm smoke` goes live.
6. **Honest audio.** Show the source codec and bitrate. Never present an upconverted file as higher quality. No Opus/WebM in final files unless the user picks "original".
7. **No DRM circumvention.** Spotify, Apple Music, Amazon Music, Tidal, Deezer and Beatport streams are never downloaded, and neither is anything behind a paywall or private. `classifyUrl` refuses the other services before yt-dlp runs. Spotify links are read only as track lists, from the public embed page with no account or token, and each track's audio comes from its YouTube match (ADR-026).

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
- We never pass `-x`. It converts without saying so (MP3 to AAC for M4A, 24-bit FLAC from Opus), leaks the source's tags and can't make AIFF. yt-dlp only downloads the stream; finalize converts, tags and adds the cover in one ffmpeg pass (ADR-015).
- `--print` implies `--quiet`: without `--progress` there is no progress output, and a wait YouTube forces before the download is silent. Our `before_dl` START print carries `available_at` for the "waiting" state.
- Without `--abort-on-unavailable-fragments`, a failed HLS fragment is skipped silently: exit 0, DONE printed, and a shorter file. With it, the reason arrives as `ERROR: \r[download] Got error: …`, split across two lines.
- ffmpeg 8 can't write an ID3 `COMM` frame: any comment key becomes `TXXX:comment`. MP3 and AIFF tags therefore come from our own ID3v2.3 writer (`engine/id3.ts`, ADR-016).
- `-vn` also drops a cover mapped with `-map 1:v:0`. Map streams explicitly and never pass `-vn`.
- ffmpeg can exit 0 on truncated input and when the output already exists (even with `-n`). Finalize reads every output back with ffprobe: codec, tags, cover and duration.
- Cancel with SIGINT to the process group (spawned `detached`). SIGTERM can orphan ffmpeg. `run.ts` SIGKILLs the group when a run closes, and the startup sweep kills groups a dead server left (ADR-018).
- `--flat-playlist` entries of SoundCloud sets are bare (id + url). Enrich them lazily within SoundCloud's ~600 requests/10 min budget, which downloads share (ADR-017).
- `watch?v=…&list=…` defaults to the whole playlist, so we ask. `list=RD…` mixes never end, so we cap them.
- SoundCloud originals need the uploader's permission and a login. Go+ tracks without a subscription are 30-second previews (`preview_only`): `--break-match-filters "format_id!*=preview"` makes yt-dlp exit 101 silently.
- No DJ app plays Opus. YouTube's AAC stream (format 140) is copied as M4A, and an MP3 source stays at its own bitrate.
- Remix suggestions (ADR-027) come from flat `ytsearch30:` and `scsearch30:` searches. Only SoundCloud's results carry a genre (the uploader's field) and tags, and YouTube's only a description snippet. SoundCloud's search took 3–14 s live (50 results took 13 s), so the web asks for YouTube alone first. A flat SoundCloud result has no formats, so it can't be checked for a Go+ preview, but in the recordings Go+ tracks came back with `duration: 30` (the preview's length), which the 90 s minimum drops.
- Spotify (ADR-026): the embed page (`open.spotify.com/embed/<type>/<id>`) needs no login and lists at most 100 rows, with no album or ISRC. It ignores `offset`, and the normal playlist page holds 30 rows, so a longer playlist comes in as its pasted track links (ADR-028), each row read from its own track page by the enricher. Read only `state.data.entity`: the page also holds an anonymous token, which must never be used, logged or committed. A track's match is `ytsearch10:<artists> - <title>` filtered by `pickMatch`. Flat YouTube Music search results carry no duration, so they can't be checked.
