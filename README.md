# DJ Scraper

Paste a YouTube or SoundCloud link (a single track or a whole playlist) and pick what you want. You get DJ-ready audio files (MP3 320, AIFF, M4A, …) with tags and artwork, in the folder you choose. Runs locally on your Mac; nothing is hosted.

> **Status:** planning and agent setup done, implementation starting. See [docs/roadmap.md](docs/roadmap.md).

## Prerequisites (macOS)
- **Node.js 24 LTS**: `nvm install` (reads `.nvmrc`). Also **pnpm**: `brew install pnpm`.
- **yt-dlp**: `brew install yt-dlp`. This also installs deno, which YouTube extraction needs.
- **ffmpeg + ffprobe 8+**: `brew install ffmpeg`.

Keep yt-dlp current, because YouTube changes break old versions: `brew upgrade yt-dlp`. If the stable release is broken, download the nightly `yt-dlp_macos` from [yt-dlp-nightly-builds](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases) and point `YTDLP_PATH` at it.

## Getting started
Available once roadmap Phase 0 is done:
```bash
pnpm install
pnpm dev        # http://localhost:5173
```

## Docs
- [Product spec](docs/product.md): flows and scope
- [Architecture](docs/architecture.md): modules, API, security, testing
- [Decisions](docs/decisions.md): ADRs
- [Roadmap](docs/roadmap.md)

## Working with Claude Code
The repo is set up for agent-driven development:

| What | Where |
|---|---|
| Project instructions (loaded automatically) | `CLAUDE.md` + one per package |
| Agents: `ytdlp-specialist`, `ui-engineer`, `test-engineer`, `code-reviewer` | `.claude/agents/` |
| Skills: `/implement [item]` (full feature loop), `/verify`, `/smoke-test [url]`, and `ytdlp` (the engine playbook Claude loads on demand) | `.claude/skills/` |
| Hooks: Biome formats every edited file; each session starts with the current roadmap phase | `.claude/settings.json`, `.claude/hooks/` |
| Playwright MCP, so agents can check the UI in a real browser | `.mcp.json` |

Typical loop: `/implement`, review the result, then ask Claude to commit.

## Responsible use
This is a personal tool. Download only what you have the right to (your own uploads, free downloads, Creative Commons, artist-permitted tracks) and respect each platform's terms. DRM-protected services are out of scope.
