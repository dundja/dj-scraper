---
name: ytdlp
description: yt-dlp + ffmpeg know-how for DJ Scraper's engine. Covers the exact flags to resolve YouTube/SoundCloud URLs, download DJ-ready audio (MP3 320, M4A, AIFF, WAV, FLAC) with tags and artwork, parse progress, cancel cleanly, map errors and stay under rate limits. Use when writing or debugging code that builds yt-dlp/ffmpeg arguments or parses their output, or when a URL fails to resolve or download.
---

# yt-dlp engine playbook

Verified 2026-10-01 against yt-dlp **2026.08.19** (README, wiki, source, issues). Re-verify when behavior differs. Deeper notes, field lists and sources are in [reference.md](reference.md).

## Install & runtime
- **Dev install:** `brew install yt-dlp ffmpeg`. Brew's yt-dlp bundles the EJS solver, curl-cffi and mutagen, and depends on **deno**, so YouTube works out of the box. Don't pip-install into macOS's system Python (3.9 is too old).
- **JS runtime:** YouTube needs one (EJS), and only deno is enabled by default. Always add our own Node as a fallback with `--js-runtimes node:<process.execPath>` (Node ≥ 22); deno keeps priority when present.
- **Updating:**
  - Brew installs refuse `-U`; use `brew upgrade yt-dlp`.
  - Stable can lag for weeks, while YouTube fixes land in **nightly** within hours to days. When stable is broken, point `YTDLP_PATH` at an unpacked nightly `yt-dlp_macos.zip` build (the onefile `yt-dlp_macos` can take ~12 s per start; see reference.md).
- **ffmpeg:** ffmpeg **and** ffprobe ≥ 8 are required for `-x`, tagging and artwork. Don't use the `ffmpeg-static` npm package (ffmpeg 6.1, no ffprobe).

## Base argv (every call)
```
--ignore-config --no-update --color never --encoding utf-8
--js-runtimes node:<process.execPath>
<options…>
-- <url>
```
- **Spawning:** only through `apps/server/src/engine/run.ts`: `run(bin, argv, { onStdoutLine, onStderrLine, signal, timeoutMs })`. It spawns with `shell: false, detached: true` (its own process group, which cancel needs), stops the group with SIGINT and then SIGKILL, and splits UTF-8 lines on `\n`, `\r\n` and a lone `\r`.
- **Secrets:** never pass them in argv (it shows up in `ps`). Use `--cookies-from-browser <browser>`, or a 0600 file passed with `--config-locations`, which is still read under `--ignore-config`.

## Resolve
Implemented in `apps/server/src/resolve/` (plan → one call → `engine/ytdlp-parse.ts`); probed live 2026-10-02 (fixtures in `apps/server/test/fixtures/`).
```
yt-dlp <base> -J --flat-playlist -I 1:<cap+1> [--no-playlist | --yes-playlist] --socket-timeout 20 -- <url>
```
- **Caps:** 5000 entries (YouTube's playlist limit), 50 for mixes. Ask for one extra row: getting it means `truncated`. `playlist_count` is the platform's own count only for YouTube playlists/albums and SoundCloud sets (e.g. 11 with 4 rows returned); it is **null** for channel tabs, mixes and SoundCloud user pages, and otherwise equals the row count only when the list ran out. `n_entries` never appears in `-J`; `requested_entries` appears whenever `-I` cut anything.
- **Result types:**
  - `_type: "video"` is one track, with full info including `formats`.
  - `_type: "playlist"` is a collection (no `multi_video` seen). Its entries are `_type: "url"` on YouTube. On SoundCloud, sets give `url_transparent` entries (with album fields) and user pages give `url` entries. Don't infer partial rows from `_type`.
- **YouTube flat entries** carry id, url, title, duration (±1 s from the full extraction) and thumbnails (4 hqdefault sizes). Playlist and mix rows carry channel/uploader; **channel-tab rows don't** (only the collection's top level names the channel); album rows have `uploader = "<artist> - Topic"`.
  - `availability` and `live_status` are null on every flat entry. Private and deleted videos show up only as the exact titles `[Private video]` and `[Deleted video]`, with null duration/channel and the placeholder thumbnail `https://i.ytimg.com/img/no_thumbnail.jpg` (drop it). Match those titles exactly: real titles can start with `[` too (`[ORIGINAL] …`).
- **SoundCloud set entries are bare:** id and url plus album fields (`album`, `album_artist`, `album_type`), with no title, duration, uploader or artwork. The url is the permalink for the first 5 rows and `https://api-v2.soundcloud.com/tracks/<id>` for the rest (secret sets append `?secret_token=…`, a credential: never log it). The set's `playlist_count` is its track count and its top-level `duration` the sum. User pages give id, url and title only. Both become `partial` rows.
  - User pages also list sets: `/<user>`, `/reposts` and `/likes` mix them in, and `/sets` and `/albums` hold only sets. A set row has **no `ie_key` key at all** and a `/sets/` URL. Keep only `ie_key == "Soundcloud"` rows and count the rest (`skippedEntries`).
  - Fill partial rows with per-row `-J --flat-playlist --no-playlist -- <row url exactly as listed>` lookups (api-v2 URLs work as is): about 1 s each (0.5 s is process start) and 3–5 SoundCloud API requests with default formats. See ADR-014 for the pacing and budget.
- **`watch?v=X&list=Y`:** yt-dlp returns the **playlist** by default. We answer `ambiguous`, then use `--no-playlist` for this track or `--yes-playlist` for the whole list.
- **Mix/Radio (`list=RD…`)** keeps paging, so always cap it. Only `watch?v=X&list=RDX` lists a mix; `playlist?list=RD…` fails with "This playlist type is unviewable" (we rewrite `RD<video id>` to the watch form). When YouTube has no mix for the seed (e.g. `jNQXAC9IVRw`), yt-dlp warns "Unable to recognize playlist. Downloading just video" and returns `_type: video`, exit 0. `RDCLAK5uy_…` lists are finite YouTube Music playlists, not mixes.
- **Channel root URLs** return nested tab playlists (`- Videos`, `- Shorts`, each cut by `-I` too). Resolve `<channel>/videos` instead.
- **YouTube Music:** `music.youtube.com/browse/MPREb_…` warns "YouTube Music is not directly supported. Redirecting to …playlist?list=OLAK5uy_…" and returns that album playlist (title `Album - …`, null top-level uploader). `music.youtube.com/watch` tracks carry `track`, `artist`, `artists`, `album`, `release_year`. Shorts have the same shape as videos.
- **Timing:** single video `-J` 1.7–2.6 s (93–636 KB); small flat lists 1–2 s; 5001 rows 38–56 s and 3.7–6.7 MB.
- **Huge playlists:** for progressive listing, `--flat-playlist --lazy-playlist -j` prints one JSON object per line (not used yet).
- **SoundCloud URL types:**
  - `/<user>` covers tracks, sets and reposts; `/tracks`, `/albums`, `/sets`, `/reposts` and `/likes` are separate pages.
  - Secret `/s-XXXX` links work. `on.soundcloud.com` short links have no extractor pattern: the generic extractor follows the redirect (one extra non-API request) and returns the track with `original_url` = the short link.

## Download (one track per process)
yt-dlp writes **only into the job's own temp dir**. Our finalize step names, tags and moves the file (ADR-006).
```
yt-dlp <base> --no-playlist
  -f <selector> -x --audio-format <fmt> [--audio-quality 320K]
  --embed-metadata [--embed-thumbnail --convert-thumbnails jpg]
  -P "<jobdir>" -o "%(id)s.%(ext)s"
  --newline --progress --progress-delta 0.5
  --progress-template "download:DL %(progress)j"
  --progress-template "postprocess:PP %(progress.postprocessor)s %(progress.status)s"
  --print "after_move:DONE %(.{id,filepath,title,track,artist,artists,uploader,album,release_year,webpage_url,acodec,abr})j"
  -- <url>
```

| Target | `-f` | `-x --audio-format` | Extras | Finalize |
|---|---|---|---|---|
| MP3 320 (default) | `ba` | `mp3` | `--audio-quality 320K` (the **default is 5, about 130 kbps VBR**) + thumbnail | tags, move |
| M4A | `ba[ext=m4a]/ba` | `m4a` (AAC is copied, not re-encoded) | thumbnail | tags, move |
| FLAC | `ba` | `flac` | thumbnail | tags, move |
| WAV | `ba` | `wav` | **no `--embed-thumbnail`** (it errors on WAV) | basic tags only, move |
| AIFF | `ba` | `best` (no conversion) | `--write-thumbnail --convert-thumbnails jpg` | **ffmpeg → AIFF + ID3v2 + cover**, move |
| Original | `ba` | `best` | thumbnail when the container allows | tags, move; warn that Opus/WebM won't load in DJ apps |

- **SoundCloud originals:** prepend `download/` to the selector, but **only** for SoundCloud jobs with a login. That format is the uploader's original file, which yt-dlp ranks first. It requires the uploader to have enabled downloads and fails with HTTP 401 without a login instead of falling back.
- **YouTube sources:** `ba` is usually Opus 251 (about 130–160 kbps), the better source for any conversion. `ba[ext=m4a]` is AAC 140 (128 kbps), the right source for M4A because it is copied.
- **AIFF:** yt-dlp can't produce it (`-x` supports best, aac, alac, flac, m4a, mp3, opus, vorbis and wav). Finalize converts with:
  `ffmpeg -i <src> -i <cover.jpg> -map 0:a -map 1:v -c:a pcm_s16be -c:v copy -disposition:v attached_pic -write_id3v2 1 -id3v2_version 3 -metadata artist=… -metadata title=… <out.aiff>`
  Untested so far: confirm the artwork shows in rekordbox.
- **ALAC:** `--audio-format alac` may silently produce AAC (suspected regression). We don't offer it; if it's ever added, check the codec with ffprobe.

### Finalize (ours, after the `DONE` line)
1. **Artist and title.** Use platform fields (`artist`/`artists`, `track`). Otherwise split the title at the **first** ` - `, ` – ` or ` — `, then apply clean-up rules. yt-dlp's README recipe `--parse-metadata "title:%(artist)s - %(title)s"` is greedy and splits at the *last* dash, which is one reason we do this ourselves.
2. **Tags.** Write artist, title, album, year and comment = `webpage_url`, with ffmpeg `-c copy -metadata …` or a tag library.
3. **Filename and move.**
   - Build the name from the template, then sanitize it (macOS + Windows rules, ≤ 180 chars).
   - Resolve the path inside the target folder. If the file exists, the job ends as `skipped`.
   - Otherwise move it (`rename`; copy + unlink on `EXDEV`, e.g. USB drives) and delete the jobdir.

## Output parsing
- **Streams:**
  - stdout carries `DL {json}` progress lines and the final `DONE {json}`.
  - stderr carries `PP …` lines (postprocess output lands there because `--print` implies `--quiet`) and the `WARNING:` / `ERROR:` lines.
- **No progress without `--progress`:** `--print` implies `--quiet`, so the flag is required.
- **Download JSON fields:** `status`, `downloaded_bytes`, `total_bytes` or `total_bytes_estimate`, `speed`, `eta`, `elapsed`, `fragment_index`/`fragment_count`, `_percent`. HLS (SoundCloud) often has no total bytes, so derive the percent from fragments.
- **Postprocessing** reports no percentage. Show "converting/tagging".
- **Forced waits:** YouTube can make yt-dlp sleep before downloading ("Sleeping N seconds as required by the site"). Show "waiting", not "stalled"; skipping the sleep gets HTTP 403.
- **Exit codes:**
  - `0` ok
  - `1` error (also on Ctrl-C)
  - `2` bad options, which means **our bug**
  - `100` update failed
  - `101` download limit hit

## Cancel
1. Send SIGINT to the process group: `process.kill(-pid, 'SIGINT')`. yt-dlp then stops its ffmpeg child too. Don't use SIGTERM: yt-dlp has no handler for it, and it can orphan ffmpeg.
2. After ~5 s, send SIGKILL to the group.
3. Delete the jobdir: `.part`, `.part-FragN`, `.ytdl`, `.temp.*` files and thumbnails.

On graceful shutdown, cancel all jobs. On startup, delete stale jobdirs.

## Errors → ErrorCode
Implemented in `apps/server/src/engine/ytdlp-errors.ts` (ordered table, fixtures in `apps/server/test/fixtures/errors/`, synthetic ones marked). Only `ERROR:` lines decide; the last one with a specific code wins. Wording verified 2026-10-02:

| stderr contains | ErrorCode | Note |
|---|---|---|
| `Unsupported URL`, `playlist type is unviewable`, `DRM`, `website is not supported` | `unsupported_url` | Unsupported URL has no `[ie]` prefix |
| `is not a valid URL` | `invalid_url` | |
| `ffmpeg not found`, `ffprobe not found` | `engine_missing` | e.g. `Postprocessing: ffprobe and ffmpeg not found` |
| `Interrupted by user` | `canceled` | our SIGINT |
| `isn't available, try again later`, `HTTP Error 429` | `rate_limited` | YouTube's starts with `Video unavailable.`, so check before `unavailable` |
| `This content isn’t available.` (no "try again later"), `not a bot`, `captcha` | `bot_check` | U+2019 apostrophe; a blocked session, not the hourly limit |
| `confirm your age` | `age_restricted` | also says "Sign in" and "cookies", so check before login |
| `Private video` | `private` | |
| `available in your country`, `geo restrict`, `from your location` | `geo_blocked` | YouTube's text is "has not made this video available in your country" |
| `members-only`, `channel's members`, `registered users`, `HTTP Error 401` | `login_required` | SoundCloud originals never say 401: it's the WARNING "Original download format is only available for registered users" + `Requested format is not available` (that WARNING is the one hint consulted when the ERROR line is generic) |
| `This video is unavailable`, `Video unavailable`, `has been removed`, `does not exist`, SoundCloud `HTTP Error 404` | `unavailable` | a missing YouTube id says "This video is unavailable" |
| `HTTP Error 403`, `Requested format is not available` | `unknown` | with a readable "update yt-dlp" message |
| `Postprocessing: …`, `Conversion failed` | `postprocess_failed` | |
| `HTTP Error 5xx` | `network` | |
| `Unable to download webpage`/`JSON metadata`, `timed out`, `Failed to resolve`, `Connection refused`/`reset` | `network` | last: 404/429 also say "Unable to download …" |

- **Exit 2** (`yt-dlp: error: …`, no `ERROR:` line) means bad options: our bug, or a yt-dlp too old for a flag we pass.
- **Previews never appear in stderr.** With `--print` or `-J`, `--match-filters "format_id!*=preview"` rejects silently (exit 0, no DONE line); the "does not pass filter" line goes to stdout only with `--no-quiet`. `--break-match-filters` exits 101 silently; `-f 'ba[format_id!*=preview]'` gives `Requested format is not available`.

## Rate limits & pacing
- **YouTube without login** allows about 300 videos per hour; past that you get "This content isn't available, try again later". Pace batches with `--sleep-requests 0.75 --sleep-interval 5 --max-sleep-interval 10`, and pause the YouTube queue for a while on `rate_limited`.
- **SoundCloud** allows about 600 API requests per 10 min. Each track costs one lookup plus one call per stream type (3–5 with default formats).
  - Enrichment paces itself in `resolve/limiter.ts` (two at a time, a 25-lookup budget refilling one per 5 s, a cooldown on `rate_limited`; ADR-014) and passes no yt-dlp sleep or retry flags.
  - `--extractor-args "soundcloud:formats=hls_aac,http_mp3"` saves 1–2 calls and skips the 64k Opus stream, but a track without those formats fails with "No video formats found!" (`errors/soundcloud-no-formats.log`). Resolve keeps default formats; downloads decide narrowing in Phase 2 (ADR-014).
  - For downloads, yt-dlp's own throttles (`--sleep-requests 1`, `--retry-sleep extractor:exp=30:600`) are an option. The roadmap weighs `--extractor-retries 1`, so a 429 fails fast and our cooldown takes over.
- **Go+ previews:** SoundCloud Go+ tracks only have 30-second `<protocol>_<preset>_preview` formats without a subscription (e.g. `hls_mp3_0_0_preview`, `duration: 30.0`); yt-dlp picks one anyway. Resolve marks such tracks `preview_only` from their formats. For downloads, refuse before spawning when every format is a preview; filters are silent (see Errors). Never deliver a preview as the track. From a region where the track is geo-blocked, SoundCloud reports a geo restriction instead.

## Cookies & logins (opt-in, per platform)
- Use them only for age-restricted or members-only YouTube videos, and for SoundCloud originals or Go+. Pass `--cookies-from-browser <browser>` to that platform's jobs only.
- Logged-in YouTube cookies are currently unreliable ("The page needs to be reloaded", issue #17389) and put the account at risk. Prefer no cookies.
- PO-token plugins (bgutil) aren't needed for public videos with the default clients. Revisit only if bot checks become routine.
