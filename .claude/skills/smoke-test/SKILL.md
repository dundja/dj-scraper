---
name: smoke-test
description: Check DJ Scraper's engine against live YouTube and SoundCloud. Resolves real URLs (and optionally downloads one short track) and reports what works. Use after updating yt-dlp, when resolves or downloads start failing, or when asked for a smoke test. Uses the network.
argument-hint: "[url ...] [--download]"
---

A live check of the engine. It uses the network, so it is never part of `pnpm test`.

Input: `$ARGUMENTS`. These are the URLs to check (default: the sample set below). Add `--download` to also download the shortest track.

1. **Engine.** Run `yt-dlp --version` and warn if the date-based version is more than ~60 days old. Also run `ffmpeg -version | head -1`, `ffprobe -version | head -1` and `command -v deno`. Deno is YouTube's JS runtime; we also pass Node as a fallback.
2. **Resolve each URL.**
   - Once `apps/server` has the smoke script: `pnpm smoke <url>` prints the normalized `ResolveResult`.
   - Until then, call yt-dlp directly:
     ```
     yt-dlp --ignore-config --no-update --js-runtimes node:"$(command -v node)" -J --flat-playlist -I 1:20 -- <url> \
       | jq '{type: ._type, title, uploader, n: (.entries // [] | length), first: (.entries // [] | .[0] | {title, duration, url})}'
     ```
3. **Download (only with `--download`).**
   - Download the shortest sample into a scratch temp dir. Use the app's real argv, or the MP3 320 recipe from the `ytdlp` skill.
   - Inspect the result with `ffprobe -hide_banner <file>`: codec, bitrate, duration, tags and attached artwork.
   - Delete the file afterwards.
4. **Report** a table: URL → type · title · entries · ✅/❌ · error code or message. For each failure, check yt-dlp's GitHub issues for that extractor, and whether a newer (nightly) yt-dlp fixes it, before changing our code.

## Sample set
Public URLs from yt-dlp's own extractor tests, checked 2026-10-01. Replace any that disappear.

| Case | URL |
|---|---|
| YouTube video (19 s) | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| YouTube playlist (small) | https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0 |
| YouTube empty playlist | https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf |
| YouTube Music album (50 tracks, royalty-free) | https://music.youtube.com/browse/MPREb_gTAcphH99wE |
| SoundCloud track | https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy |
| SoundCloud secret link (10 s) | https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp |
| SoundCloud set | https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep |
| SoundCloud album set | https://soundcloud.com/leviryan/sets/out-of-spite |
| SoundCloud downloadable track (the original needs a login) | https://soundcloud.com/the80m/the-following |

Shortest download candidates: the SoundCloud secret link (10 s), then the YouTube video (19 s).
