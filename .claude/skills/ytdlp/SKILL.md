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
  - Stable can lag for weeks, while YouTube fixes land in **nightly** within hours to days. When stable is broken, point `YTDLP_PATH` at the nightly `yt-dlp_macos` binary.
- **ffmpeg:** ffmpeg **and** ffprobe ≥ 8 are required for `-x`, tagging and artwork. Don't use the `ffmpeg-static` npm package (ffmpeg 6.1, no ffprobe).

## Base argv (every call)
```
--ignore-config --no-update --color never --encoding utf-8
--js-runtimes node:<process.execPath>
<options…>
-- <url>
```
- **Spawning:** `spawn(bin, argv, { shell: false, detached: true })`. Detached gives the process its own group, which cancel needs. Call `setEncoding('utf8')` on both streams and split them into lines.
- **Secrets:** never pass them in argv (it shows up in `ps`). Use `--cookies-from-browser <browser>`, or a 0600 file passed with `--config-locations`, which is still read under `--ignore-config`.

## Resolve
```
yt-dlp <base> -J --flat-playlist -I 1:1000 [--no-playlist | --yes-playlist] -- <url>
```
- **Result types:**
  - `_type: "video"` is one track, with full info including `formats`.
  - `_type: "playlist"` or `"multi_video"` is a collection. Its entries are `_type: "url"` on YouTube. On SoundCloud, sets give `url_transparent` entries (with album fields) and user pages give `url` entries. Don't infer partial rows from `_type`.
- **YouTube flat entries** carry id, url, title, duration, channel/uploader and thumbnails. That's enough for the track table.
  - `availability` is null on every flat entry. Private and deleted videos show up only as the exact titles `[Private video]` and `[Deleted video]`, with no duration or channel and the placeholder thumbnail `https://i.ytimg.com/img/no_thumbnail.jpg` (drop it). Match those titles exactly: real titles can start with `[` too.
- **SoundCloud set entries are bare:** id and url (plus album fields), with no title, duration, uploader or artwork. User pages (`/<user>/tracks`) give id, url and title only. Both become `partial` rows.
  - User pages also list sets: `/<user>`, `/reposts` and `/likes` mix them in, and `/sets` and `/albums` hold only sets. A set row looks like a track row but has `ie_key: null` and a `/sets/` URL. Keep only `ie_key == "Soundcloud"` rows as entries and report how many sets were skipped. Fill them with per-track `-J --no-playlist -- <entry url>` lookups, done lazily and a few at a time; they count against SoundCloud's API budget.
- **`watch?v=X&list=Y`:** yt-dlp returns the **playlist** by default. We answer `ambiguous`, then use `--no-playlist` for this track or `--yes-playlist` for the whole list.
- **Mix/Radio (`list=RD…`)** keeps paging, so always cap it with `-I 1:50`.
- **Channel root URLs** return nested tab playlists. Rewrite them to `<channel>/videos` first.
- **Huge playlists:** for progressive listing, `--flat-playlist --lazy-playlist -j` prints one JSON object per line (no `n_entries`).
- **SoundCloud URL types:**
  - `/<user>` covers tracks, sets and reposts; `/tracks`, `/albums`, `/sets`, `/reposts` and `/likes` are separate pages.
  - Secret `/s-XXXX` links and `on.soundcloud.com` short links also work.

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
Match stable substrings of `ERROR:` lines and keep real samples as fixtures. These are starting points; confirm them against real output.

| stderr contains | ErrorCode |
|---|---|
| `Unsupported URL` | `unsupported_url` |
| `Private video` | `private` |
| `Video unavailable`, `has been removed`, `does not exist` | `unavailable` |
| `not available in your country`, `geo restrict` | `geo_blocked` |
| `confirm your age`, `age-restricted` | `age_restricted` |
| `not a bot` | `bot_check` |
| `HTTP Error 429`, `isn't available, try again later` | `rate_limited` |
| `HTTP Error 401` (SoundCloud original), `members-only` | `login_required` |
| `does not pass filter` (preview filter) | `preview_only` |
| `ffmpeg not found`, `ffprobe` … `not found` | `engine_missing` |
| `Postprocessing:`, `Conversion failed` | `postprocess_failed` |
| `Unable to download webpage`, `timed out`, `Connection reset` | `network` |

## Rate limits & pacing
- **YouTube without login** allows about 300 videos per hour; past that you get "This content isn't available, try again later". Pace batches with `--sleep-requests 0.75 --sleep-interval 5 --max-sleep-interval 10`, and pause the YouTube queue for a while on `rate_limited`.
- **SoundCloud** allows about 600 API requests per 10 min. Each track costs one lookup plus one call per stream type.
  - Throttle with `--sleep-requests 1 --extractor-retries 5 --retry-sleep extractor:exp=30:600`.
  - Without a login, `--extractor-args "soundcloud:formats=hls_aac,http_mp3"` cuts calls and skips the 64k Opus stream.
- **Go+ previews:** SoundCloud Go+ tracks only have 30-second `*_preview` formats without a subscription. Filter with `--match-filters "format_id!*=preview"` (from issue #8390; verify the behavior) and report `preview_only`. Never deliver a preview as the track.

## Cookies & logins (opt-in, per platform)
- Use them only for age-restricted or members-only YouTube videos, and for SoundCloud originals or Go+. Pass `--cookies-from-browser <browser>` to that platform's jobs only.
- Logged-in YouTube cookies are currently unreliable ("The page needs to be reloaded", issue #17389) and put the account at risk. Prefer no cookies.
- PO-token plugins (bgutil) aren't needed for public videos with the default clients. Revisit only if bot checks become routine.
