# Product

<!-- impeccable:product-schema 1 -->

The feature spec (sources, flows, quality, non-goals) is `docs/product.md`; the design decisions are `docs/decisions.md`. This file holds the durable product truth that design work starts from.

## Platform

web

## Users
One DJ (the owner) on their own Mac. They paste YouTube, SoundCloud and Spotify links to collect tracks, find remixes of a song, audition them, and save DJ-ready files into the folder they choose. There is no other audience: no accounts, no sharing, no team.

## Product Purpose
One paste → DJ-ready audio files in the folder you want. A link becomes a track card or a track list, with honest source quality, and downloads are converted, tagged and given artwork in one pass, never overwriting a file. Success: the tracks that end up in the folder load straight into Rekordbox with correct names, tags and covers, and the DJ never wonders what quality a file really is.

## Positioning
A local, single-user front end over yt-dlp and ffmpeg, made for DJ crate building rather than generic downloading:
- **Honest audio**: the source codec and bitrate are shown, every finished file is read back and reported as what it is, and nothing upconverted is presented as higher quality.
- **DJ-ready files**: the formats DJ software plays (MP3, M4A, AIFF, WAV, FLAC), tags and covers written by our own ID3 writer, filenames sanitized.
- **Digging, not just grabbing**: remix suggestions under a pasted track, grouped by version, with genres taken only from the platforms' words, and auditioning in the app with a tempo control.
- **Spotify as track lists**: names and covers from Spotify's public pages, audio matched on YouTube; Spotify's own streams are never touched.

## Operating Context
- Used at home, at a desk, while preparing sets: digging for tracks and remixes and building crates before a gig.
- The files go into **Rekordbox** (Pioneer gear). What happens after the folder is Rekordbox's job: library management is a non-goal.
- Runs only on this machine: a browser tab on `localhost` plus a local Node server, started with `pnpm start`. macOS (the native folder picker, Reveal in Finder, protected-folder prompts).
- Sessions mix single tracks (paste → auto-download) and long lists (playlists up to 5,000 rows, picked and downloaded in batches paced against platform rate limits).

## Capabilities and Constraints
- Sources: YouTube and SoundCloud first-class; other yt-dlp sites best effort; Spotify only as track lists matched on YouTube (ADR-026, ADR-028). DRM services are refused by URL.
- No DRM circumvention, nothing behind a paywall or private; no Spotify streams.
- Files go only into the folder the user chose, never overwriting silently. The one exception is the server's own preview cache for auditioning (ADR-029).
- The server binds `127.0.0.1` only; no accounts, no cloud, no data leaves the machine except the platform requests themselves. No LLM or remote classification (ADR-027).
- Platform budgets are real constraints: YouTube allows roughly 300 tracks/hour without a login, and SoundCloud's request budget is shared between filling in rows, remix searches, previews and downloads.
- Open: settings page, filename clean-up rules, already-downloaded detection, download history, optional sign-ins (see `docs/roadmap.md`).

## Brand Commitments
- Name: **DJ Scraper**.
- Voice: plain and specific. Errors are written for humans with a next step ("Private video", "Preview only (SoundCloud Go+)", "No YouTube upload matches this Spotify track"). Say what really happened, including what was skipped or re-encoded; never dress up quality.

## Evidence on Hand
- No testimonials, users, metrics or press exist; it is a personal tool. Don't invent any.
- Real behavior is recorded: yt-dlp, ffmpeg and Spotify fixtures under `apps/server/test/fixtures/`, and Playwright e2e flows against the fake engine in `apps/web/e2e/`.

## Product Principles
1. **Truth over polish.** Show what the source and the file really are; a guess is shown as a guess (e.g. a genre from a title).
2. **One paste, then out of the way.** The common path (paste a track → it downloads) takes no extra decisions; choices appear only where they matter (playlist or track, which tracks, which upload).
3. **Never lose or clobber the user's files.** Writes go only where they said, nothing is overwritten, and every failure says why and what to do next.
4. **Respect the platforms.** Pace requests within their budgets, back off when limited, and never circumvent DRM or access controls.
5. **Fast with big lists.** Thousands of rows stay smooth; slow platform work fills in progressively instead of blocking.

## Accessibility & Inclusion
No formal standard: a personal tool for one user. Keep the existing practice anyway: keyboard-operable controls, labelled controls for screen readers, and respect for reduced motion.
