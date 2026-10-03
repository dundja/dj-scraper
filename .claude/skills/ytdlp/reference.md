# yt-dlp reference notes

Supporting detail for [SKILL.md](SKILL.md), verified 2026-10-01 against yt-dlp stable 2026.08.19 and nightly 2026.09.27. The download, conversion and finalize notes were verified with live and offline runs on 2026-10-02 and 2026-10-03 (yt-dlp 2026.08.19, ffmpeg/ffprobe 8.0). `#N` refers to github.com/yt-dlp/yt-dlp/issues/N.

## Install options (macOS)
| Option | Notes |
|---|---|
| `brew install yt-dlp` | Python venv with yt-dlp-ejs, curl-cffi and mutagen. Depends on deno, does not include ffmpeg. Update with `brew upgrade` (`-U` is refused). |
| `yt-dlp_macos` (GitHub release) | universal2 PyInstaller onefile, macOS 10.15+. Bundles Python, EJS, curl-cffi and mutagen, and self-updates (`-U`, `--update-to nightly`). It unpacks itself on **every** start: about 11.7 s per start was measured on a Mac with endpoint security (CrowdStrike, Defender), and every download pays it. |
| `yt-dlp_macos.zip` | Unpacked variant (`darwin_dir`): no self-update, and about 0.3 s per start after a slow first run. Prefer it for `YTDLP_PATH` nightlies, and as the build to ship with the app. |
| pip / pipx / uv | Needs Python ≥ 3.10 (3.11+ recommended), so not the system Python 3.9. Install `"yt-dlp[default,curl-cffi]"`. |

**Release channels.** Stable ships roughly monthly and the README calls it "often stale"; it recommends nightly. Recent YouTube fixes reached nightly in 2.5 h (#15814), ~9 h (#17456) and ~4 days (#16150). Nightlies can regress too (#17448).

## JavaScript runtime (EJS)
- **Since 2025.11.12** a JS runtime is required for full YouTube support. Without one, only the `visionos` client is used and some formats may be missing.
- **Priority:** deno > node > quickjs > bun. Only deno is enabled by default.
- **Minimum versions:**
  - Deno 2.3.0
  - Node 22
  - Bun 1.2.11–1.3.14 (deprecated)
  - QuickJS ≥ 2023-12-09 (builds before 2025-04-26 are very slow), or any QuickJS-NG
- **Flags:** `--js-runtimes node` or `node:/abs/path` adds Node. `--no-js-runtimes --js-runtimes node:/path` forces Node only.
- **Solver scripts** are bundled in brew, `yt-dlp_macos`, the zipimport binary and pip `[default]`. Other installs need `--remote-components ejs:github`.

## YouTube clients, PO tokens, cookies
- **Player clients:**
  - default: `visionos,web` (`web` is dropped without a JS runtime)
  - logged in: `web_embedded,tv_downgraded,web`
  - Premium: `web_creator,tv_downgraded,web`
  - `web_music` is added for music.youtube.com when logged in.
- **PO tokens:** public videos need none with the default clients. If that changes, use bgutil-ytdlp-pot-provider (2.0.0, 2026-09-08; HTTP server on 127.0.0.1:4416 or script mode) with `--extractor-args "youtube:player_client=mweb"`. Note that `--no-plugin-dirs` disables plugins like this.
- **Cookies:**
  - Use them only for age-restricted, members-only, private-playlist and Premium content; the account can get banned.
  - Logged-in cookies currently often fail with "The page needs to be reloaded" (#17389). The maintainer's workaround is to drop cookies, or use a PO-token plugin with `mweb` (logged out) or `web_creator` (logged in) (#17497).
- **Rate limits:** about 300 videos/h without login and about 2000/h with an account. The symptom is "This content isn't available, try again later". The `-t sleep` preset expands to `--sleep-requests 0.75 --sleep-interval 10 --max-sleep-interval 20 --sleep-subtitles 5`.
- **Pre-roll sleep:** yt-dlp waits out the pre-roll ad length when YouTube requires it ("Sleeping N seconds as required by the site"). Skipping the wait gets HTTP 403.

## Audio formats
YouTube:

| id | Codec | Bitrate | Notes |
|---|---|---|---|
| 251 | Opus (WebM) | ~130–160 kbps VBR | usual `ba` |
| 140 | AAC (m4a) | 128 kbps | `ba[ext=m4a]`; copied to M4A without re-encoding |
| 141 | AAC | 256 kbps | needs Premium cookies; reportedly reachable via `web_music` + a music.youtube.com URL (#17729, unconfirmed) |
| 774 | Opus | 256 kbps | needs Premium cookies |

SoundCloud, without login (2026 logs, #17651 and #14216):

| format_id | Codec / bitrate |
|---|---|
| `http_mp3_0_0`, `hls_mp3_0_0` | MP3 128 kbps (the numeric suffix varies; match the prefix) |
| `hls_aac_96k` | AAC 96 kbps |
| `hls_aac_160k` | AAC 160 kbps (best without login) |
| `hls_opus_0_0` | Opus 64 kbps (ranked above AAC and MP3; our selector `ba[acodec!=opus]/ba` skips it) |
| `hls_aac_256k` | AAC 256 kbps (Go+) |
| `download` | Uploader's original (wav/flac/mp3…). Needs downloads enabled **and** a login (HTTP 401 otherwise). Ranked first. Rate-limited: after ~10 tracks it silently falls back (#15093). |
| `*_preview` | 30-second previews of Go+-only tracks |

**SoundCloud access:**
- **Login:** `--cookies-from-browser`, which reads the `oauth_token` cookie. `--username oauth --password <token>` also works, but don't use it: argv is visible in `ps`.
- **API budget:** about 600 requests per 10 min.
- **Paged lists** (users, likes) need curl-cffi browser impersonation, which brew and the onefile binary bundle.

## yt-dlp's own conversion (not used for downloads)
Why downloads pass no `-x` and do the conversion in finalize (ADR-015). Measured 2026-10-02 offline and live.
- **`-x --audio-format`:** best, aac, alac, flac, m4a, mp3, opus, vorbis, wav. There is no aiff.
- **It copies when the source codec equals the target:** a SoundCloud MP3 128k stays 128 kbps for "mp3" (byte-identical; `--audio-quality` is ignored), and AAC → m4a is a copy.
- **It transcodes silently otherwise:** a SoundCloud MP3 128k became AAC ~160 kbps for m4a (lossy to lossy, with a bigger number), and `-x flac` from Opus gave a **24-bit** FLAC (32.6 MB against 18.3 MB at 16-bit for 5 minutes). `-x best` on a WebM remuxes to `.opus` (Ogg), and that remux decodes 648 samples (13.5 ms) longer.
- **`--audio-quality`:**
  - Values above 10 are CBR: `320K` becomes `-b:a 320k`.
  - 0–10 is VBR for mp3/vorbis/aac (0 = LAME V0).
  - **The default is 5, i.e. LAME V5 at about 130 kbps.**
  - It's ignored for opus, flac, alac, wav and copies.
- **Source tags leak:** even without `--embed-metadata`, the source's container tags end up in every output (MP3 `DESCRIPTION`, FLAC `comment`, m4a `desc`). `--embed-metadata` itself writes `description`, `synopsis`, `purl`, `comment=webpage_url`, `date=upload_date` (YYYYMMDD) and `genre=tags`.
- **ALAC:** since a 2022 refactor, `--audio-format alac` may produce AAC (from reading the code, untested).
- **`--embed-thumbnail`** works for mp3, m4a/mp4, flac, opus/ogg and mkv/mka, and errors on WAV, AIFF and WebM. `--convert-thumbnails jpg` runs with no quality option (75 KB at PSNR 36.1 dB on a noisy 1280×720 WebP, against 245 KB at 38.8 dB with `-q:v 2`).
- **Splitting "Artist - Title":** the README's `--parse-metadata "title:%(artist)s - %(title)s"` is greedy and splits at the last " - ". The non-greedy regex is `"title:(?P<artist>.+?)\s+[-–—]\s+(?P<title>.+)"`. We split in TypeScript instead (`splitArtistTitle`).

## Finalize recipes (ffmpeg 8)
What `engine/finalize-plan.ts` builds and `engine/finalize.ts` runs, in `<jobDir>/finalize/` with fixed names (`out.<ext>`, `cover.jpg`, `final.<ext>`). The probed JSON of real sources and outputs is in `apps/server/test/fixtures/ffprobe/` (its README has the exact argv per output). `apps/server/test/finalize-real-ffmpeg.test.ts` runs these against the real ffmpeg (`DJS_TEST_REAL_FFMPEG=1`).

**ffprobe** (the download, then the output):
```
ffprobe -hide_banner -v error -protocol_whitelist file
  -show_entries format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic
  -of json -i <file>
```
- Most numbers are strings (`"48000"`, `"19.021000"`); `index` and `channels` are numbers. Opus and FLAC streams have no `bit_rate`.
- Tag keys keep each container's case (WebM: `title` but `ARTIST`, `COMMENT`), and Ogg keeps its tags on the stream. Compare keys lower-cased.
- `disposition` is a section: `stream=disposition` prints nothing, so ask for `stream_disposition=attached_pic`.
- ffprobe reports `TXXX:comment` and FLAC's `DESCRIPTION` as `comment` either way: check ID3 comment frames at byte level.
- A truncated WebM probes with its full declared duration; only the format `bit_rate` gives it away.
- An MP3 without a Xing/Info header (VBR podcasts, stitched files) has its duration **estimated** from the first frame's bitrate (`Estimating duration from bitrate, this may be inaccurate`, only at `-v warning`): a 600 s VBR file with 120 s of silence first probes as 2,413 s (`ffprobe/src-mp3-vbr-noxing.json`). The outputs ffmpeg writes have a Xing header and probe exactly.

**Measuring an MP3** (`measureArgs`, when the demuxer is `mp3`; decodes nothing, ~150 MB/s, 60 s timeout):
```
ffmpeg -hide_banner -nostdin -loglevel error -n -nostats -progress pipe:1 -protocol_whitelist file -i <download>
  -map 0:a:0 -c:a copy -f null -
```
stdout ends with `out_time_us=600032653` … `progress=end` (`out_time_ms` is microseconds too). That length replaces ffprobe's for every duration check, the WAV/AIFF size guard and the audio timeout; a truncated MP3 still measures short.

**Codec plan** (`planAudio`; copy when the source has the target codec):

| Target | Copy when the source is | Else | `-f` / extension |
|---|---|---|---|
| mp3 | mp3 | `-c:a libmp3lame -b:a 320k` | `mp3` / `.mp3` |
| m4a | aac | `-c:a aac -b:a 256k` | `ipod` / `.m4a` |
| flac | flac | `-c:a flac -sample_fmt s16` | `flac` / `.flac` |
| wav | never | `-c:a pcm_s16le` | `wav` / `.wav` |
| aiff | never | `-c:a pcm_s16be` | `aiff` / `.aiff` |
| original | always (`-c:a copy`) | – | WebM/Matroska + Opus/Vorbis → `webm`; MP4 + AAC → `ipod`; Ogg + Opus → `opus`; Ogg + Vorbis → `ogg`; else by codec (mp3, flac, aac → `ipod`, opus → `webm`, vorbis → `ogg`); anything else → `postprocess_failed` |

- More than two channels: `-ac 2` (forces an encode; not for original). The sample rate stays native: 48 kHz from Opus, 44.1 kHz from AAC/MP3. 16-bit is right for lossy sources.
- WAV and AIFF fail early when duration × rate × channels × 2 ≥ 4 GiB.
- A download ffprobe reads as `hls`, `dash`, `concat`, `ffconcat` or `image2` is refused: those demuxers open other files.

**Cover pass** (when a usable thumbnail exists; `<pipe>` from sniffing: `jpeg_pipe`, `png_pipe` or `webp_pipe`):
```
ffmpeg -hide_banner -nostdin -loglevel error -n -xerror -protocol_whitelist file -f <pipe> -i <thumbnail>
  -map 0:v:0 -frames:v 1 -vf "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease"
  -c:v mjpeg -q:v 2 -pix_fmt yuvj420p -f image2 -update 1 <cover.jpg>
```
A baseline JPEG of at most 1000 px, never scaled up (YouTube 480×360 stays; SoundCloud 1500×1500 becomes 1000×1000, ~170 KB).

**Audio pass** (`audioArgs`):
```
ffmpeg -hide_banner -nostdin -loglevel error -n [-xerror] -protocol_whitelist file -i <download>
  [-protocol_whitelist file -f jpeg_pipe -i <cover.jpg>]          M4A and FLAC with a cover
  -map 0:a:0 [-map 1:v:0] <codec args> [-ac 2]
  [-c:v copy -disposition:v:0 attached_pic -metadata:s:v:0 "title=Album cover" -metadata:s:v:0 "comment=Cover (front)"]
  -map_metadata -1 -map_chapters -1
  [-metadata title=… -metadata artist=… -metadata album=… -metadata album_artist=… -metadata date=<YYYY> -metadata comment=<url>]
  <muxer options> -f <muxer> <out.ext>
```
- `-xerror` only when the pass decodes, and never for an MP3 source (ADR-015 amendment): a stitched MP3 (ad + episode, the episode's ID3v2 tag mid-stream) gives `[mp3float @ …] Header missing`, exit 183 with `-xerror` and exit 0 with a whole output without it, for M4A, FLAC, WAV and AIFF alike. Muxer options: mp3 `-id3v2_version 0 -write_id3v1 0`, aiff `-write_id3v2 0` (no tags from ffmpeg: ours follow), ipod `-movflags +faststart` (`moov` first, no measurable cost).
- **Never `-vn`.** With `-map 1:v:0` it still drops the cover: exit 0, no video stream. `-map 0:a:0` alone already excludes video.
- The cover needs `-disposition:v:0 attached_pic`: without it M4A fails (`Could not find tag for codec mjpeg`, exit 234, a 0-byte file) and FLAC drops the cover silently. `comment=Cover (front)` sets picture type 3; without it the type is 0 (Other). WAV, WebM and Ogg can't hold a cover (exit 234, or "ignored").
- Tag keys: `date=YYYY` becomes TYER, `©day`, Vorbis `date`, WAV `ICRD` and Matroska `DATE`; `year=` becomes `TXXX:year` or is dropped. `comment` becomes M4A `©cmt`, WAV `ICMT`, WebM `COMMENT`, FLAC/Ogg `DESCRIPTION`, and in MP3/AIFF a `TXXX:comment` (ffmpeg 8 can't write COMM, USLT, WOAS or WXXX under any key). WAV drops `album_artist` (no INFO key). An empty `-metadata k=` removes the key.
- Values pass `cleanTagValue` first: a newline would be written verbatim, and a NUL makes `spawn` throw.
- ffmpeg adds its own encoder tag (`encoder=Lavf…`, MP3's Xing header `Lavc…`); `-fflags +bitexact` would drop it. We keep it.

**ID3v2.3 for MP3 and AIFF** (`engine/id3.ts`):
- Header `ID3` 3.0, no flags, syncsafe size; frames in order TIT2, TPE1, TALB, TPE2, TYER, COMM (`eng`, empty description), APIC (`image/jpeg`, type 3, empty description); then 2,048 bytes of padding.
- Text frames: encoding 0 (ISO-8859-1) when every UTF-16 unit is below 0x100, else 1 (UTF-16 with a BOM), NUL-terminated. Frame sizes are plain big-endian (v2.3), no unsynchronisation, no extended header: the layout ffmpeg itself writes.
- MP3: ffmpeg's output starts at the first frame sync (`-id3v2_version 0`); the tag is written first, then the audio streamed after it, into `final.mp3`.
- AIFF: ffmpeg writes `FORM…AIFF` with `COMM` and `SSND` only (`-write_id3v2 0`). Append `ID3 ` + a big-endian length + the tag + a pad byte when the length is odd, then rewrite the FORM size at offset 4 (file length − 8; more than 2³²−1 fails).

**Readback** (`outputProblem`, `downloadProblem`): the output's codec is the planned one; for formats ffmpeg tags, title and artist are there; an `attached_pic` stream when a cover was planned for M4A/FLAC; the output's duration within max(2 s, min(1 %, 10 s)) of the input's (an MP3's measured one), and the input's within the same of yt-dlp's `duration` (else `network`, "incomplete").

**Failure texts** (ffmpeg 8; decide by exit code, except that "No space left on device" anywhere on stderr is `disk_full`, and quote the last non-empty stderr line without its `[name @ 0x…] ` prefixes, which ffmpeg 8 nests (`[aist#0:0/mp3 @ 0x…] [dec:mp3float @ 0x…] …`), skipping the trailers `Terminating thread with return code …`, `Task finished with error code …` and `Last message repeated …` unless nothing else is left):

| Case | Exit | Last stderr line |
|---|---|---|
| Missing input | 254 | `Error opening input files: No such file or directory` |
| Empty, HTML or truncated-m4a input | 183 | `Error opening input files: Invalid data found when processing input` |
| A cover the container can't hold, a bad cover | 234, 0-byte file left | `Could not write header …` |
| Input with no audio | 234 | `Error opening output files: Invalid argument` (`Stream map '' matches no streams.`) |
| **Output exists, with `-n`** | **0** | `File '…' already exists. Exiting.`, the file untouched |
| **Truncated WebM → MP3, even with `-xerror`** | **0** | `File ended prematurely`; 4.834 s out of 19.021 s |
| **Corrupt FLAC without `-xerror`** | **0** | decode errors only logged |
| Stitched MP3 (mid-stream ID3v2) → AAC/FLAC/PCM **with** `-xerror` | 183 | `Header missing`, then `[aist#0:0/mp3 @ …] [dec:mp3float @ …] Error submitting packet to decoder: …`, `Error processing packet in decoder: …`, `Task finished …`, `Terminating thread …`; without `-xerror`: exit 0, the whole length |
| Output on a full drive (any muxer) | 228 (−28) | `Error submitting a packet to the muxer: No space left on device` … `Error writing trailer: No space left on device`, `Error closing file: No space left on device` |

- ffmpeg 8 prints `[opus @ 0x…] Error parsing Opus packet header.` for every Opus-in-WebM read, including YouTube's 251 and good files, and still exits 0; `-xerror` doesn't trip on it. Skip that line when quoting.
- Exit codes are the AVERROR value & 0xff: treat any non-zero as failure, don't map codes.
- Timings for a 5-minute input: copy + tags + cover ~0.1 s, MP3 320 encode ~2 s, FLAC or WAV ~0.6 s, AIFF from Opus ~0.6 s, the cover +0.1–0.3 s.

## Files & paths
- **Locations:** `-P home:<dir> -P temp:<dir>`, plus `-o` templates with fallbacks such as `%(artist,uploader)s`.
- **Filename sanitizing:**
  - By default `"*:<>?|/\` become full-width lookalikes.
  - `--windows-filenames` adds Windows rules; `--restrict-filenames` allows ASCII only; `--trim-filenames N` caps the length.
  - We don't use any of it: downloads are named `%(id)s.%(ext)s` in the job dir, and `filename.ts` in shared names the final file.
- **Overwrites:** existing files aren't overwritten by default. `-w`/`--no-overwrites` skips every existing file; `--force-overwrites` implies `--no-continue`.
- **Archive:** `--download-archive FILE` appends `<extractor> <id>` after each success. Archived items print nothing with `--print`.
- **Network:**
  - `-N 4` (concurrent fragments) helps HLS (SoundCloud), not YouTube.
  - Retries default to `-R 10 --fragment-retries 10 --extractor-retries 3`; `--retry-sleep exp=1:30` adds back-off.
  - `--retries` (plain HTTP) retries only 5xx and transport errors; a 4xx fails at once (`unable to download video data: HTTP Error 429`).
  - `--fragment-retries` retries any HTTP error, 404 and 429 included, with no sleep and ignoring `Retry-After`, then **skips the fragment silently** (exit 0, a shorter file) unless `--abort-on-unavailable-fragments`. With it: exit 1, `ERROR: \r[download] Got error: HTTP Error 404: Not Found. Giving up after N retries` and `ERROR: fragment 3 not found, unable to continue`.
  - SoundCloud's `--extractor-retries N` allows N+1 attempts, each asking for every format's info again; `0` fails on the first 429 (from source, `extractor/soundcloud.py`).
  - `--max-filesize` is enforced only by the plain HTTP downloader; HLS ignores it.
  - Downloads use `--socket-timeout 20 --retries 3 --fragment-retries 3 --retry-sleep fragment:exp=1:8 --abort-on-unavailable-fragments`, and `--extractor-retries 0` for SoundCloud.

## Output streams & progress
- **`--print`** implies `--quiet`, and also `--simulate` except for late stages like `after_move`, so add `--progress`.
- **Where output goes:**
  - The download progress template goes to stdout.
  - The postprocess template goes to stderr in quiet mode.
  - Warnings and errors go to stderr; `--no-warnings` mutes warnings.
- **`%(progress)j`** prints one JSON line.
  - Download fields: status, downloaded_bytes, total_bytes, total_bytes_estimate, speed, eta, elapsed, filename, tmpfilename, fragment_index, fragment_count, `_percent`, `_*_str`.
  - Postprocess fields: status (started/processing/finished) and postprocessor.
- **Final path:** `--print after_move:filepath` (use `%(filepath)j` for a JSON-safe value), or `--print-to-file "after_move:%(filepath)s" FILE`.
- **`--print before_dl:`** runs after format selection and before the before-download postprocessors and any forced sleep, so it can announce the stream and `available_at` before yt-dlp waits.
- **`%(.{a,b,c})j`** prints only the fields that exist, as one JSON object; a dotted path such as `thumbnails.-1.filepath` becomes a literal key. `%()j` output is ASCII-only (`\u0308`).
- **`thumbnails.-1`** is the written thumbnail: yt-dlp drops candidates that fail and stops at the first success. Without `--write-thumbnail`, it is just the top-ranked candidate URL (YouTube's `maxresdefault.webp`, which may not exist).
- **Forced sleeps:** `yt_dlp/downloader/common.py` waits `available_at - int(time.time())` seconds and reports it with `to_screen`, which quiet mode suppresses. YouTube sets `available_at` on every non-live format (`ceil(now)` + ad seconds, else `int(now)`).
- **`--encoding utf-8`:** without it, characters that don't fit the stream encoding are silently dropped.

## Process control
- **Exit codes:**
  - 0: ok. A download that a `--match-filters` filter rejected, or that `--max-filesize` stopped, also exits 0, just without a `DONE` line.
  - 1: any error. Playlists continue past failures but still exit 1; Ctrl-C also exits 1.
  - 2: option error
  - 100: update failed
  - 101: `--max-downloads` or a `--break-*` limit was reached
- **Signals:** SIGINT also stops yt-dlp's ffmpeg child (exit 1 about 30–70 ms later, `ERROR: Interrupted by user`, nothing left in the group, also mid-fixup); there is no SIGTERM handler.
- **Orphans:** a detached group survives its parent (it is re-parented to launchd, group intact), so a crashed server leaves yt-dlp and its ffmpeg running. Every member's argv names the job dir (yt-dlp's `-P`, ffmpeg's `file:` paths); ffmpeg's argv[0] is a bare `ffmpeg`. `ps -A -ww -o pid=,pgid=,command=` with `LANG=C LC_CTYPE=en_US.UTF-8` prints non-ASCII paths raw (with `LC_ALL=C` they come out vis-escaped); `etimes` doesn't exist on macOS, and `lstart` is localized.
- **Leftover files:** `.part`, `.part-FragN`, `.ytdl`, `.temp.*` and thumbnails.
- **Onefile binary:** whether it forwards signals to its child is unverified, so prefer the process-group kill.

## ffmpeg
- **Needed for:** yt-dlp's container fix-ups (FixupM4a for YouTube m4a, FixupM3u8 for SoundCloud HLS), and our finalize: probing, converting, tagging and covers (see Finalize recipes).
- **Builds:** yt-dlp/FFmpeg-Builds has no macOS builds, and no patches are needed since ffmpeg 8. Use brew ffmpeg ≥ 8, or ship ffmpeg and ffprobe together and pass `--ffmpeg-location <dir>`.
- **Avoid** the npm `ffmpeg-static`: 5.3.0 bundles ffmpeg 6.1.1 without ffprobe, and `ffprobe-static` was last published in 2022.

## DJ software compatibility
| | MP3 | AAC/M4A | WAV | AIFF | FLAC | ALAC | Vorbis | Opus |
|---|---|---|---|---|---|---|---|---|
| rekordbox 7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| CDJ-3000(X) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Serato DJ Pro (unverified) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| Traktor | ✓ | ✓ | ✓ | ✓ | ✓ | ? | ✓ | – |
| Engine DJ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |

- CDJ-3000(X) plays lossless up to 96 kHz, and AAC only at 44.1/48 kHz.
- No DJ app plays Opus.
- **WAV vs AIFF:** ffmpeg writes only basic RIFF INFO tags and no artwork to WAV, and rekordbox users report missing WAV artwork. AIFF carries ID3v2 tags plus a cover in an `ID3 ` chunk; ours is written by `engine/id3.ts` after the last chunk. Whether rekordbox, Serato and Traktor read our COMM frame, that trailing chunk and FLAC's `DESCRIPTION` is still unverified.

## Sources
- yt-dlp:
  - README (github.com/yt-dlp/yt-dlp)
  - release notes 2025.11.12 through 2026.08.19
  - wiki pages: EJS, PO-Token-Guide, Extractors, FAQ, Installation
- Packages:
  - formulae.brew.sh/formula/yt-dlp
  - github.com/Brainicism/bgutil-ytdlp-pot-provider
  - github.com/yt-dlp/FFmpeg-Builds
  - npmjs.com/package/ffmpeg-static
- FFmpeg source: `aiffenc.c` and `wavenc.c`
- Format support pages from AlphaTheta/rekordbox, Serato, Native Instruments and Engine DJ

## Version probes (health)
Recorded 2026-10-02; fixtures are in `apps/server/test/fixtures/engine/`.
- **Commands:**
  - `yt-dlp --ignore-config --no-update --version` prints only `__version__`. Stable is `YYYY.MM.DD`, a same-day re-release `YYYY.MM.DD.N`, nightly and master `YYYY.MM.DD.HHMMSS`. A git checkout prints the last stable version. The first three parts are the release day.
  - `ffmpeg -version` / `ffprobe -version` print `<prog> version <FFMPEG_VERSION>` on stdout. The version is a release (`8.0`, `9.0.2`), `git describe` output (`N-127085-g…`, `n8.0-12-g…`) or `git-YYYY-MM-DD-hash`, plus an optional `-<extra>` (`-tessus`, `-static`, `-3ubuntu5`). For git builds, the major is libavformat's major minus 54. ffmpeg 8 also prints `Exiting with exit code 0` after it.
  - `deno --version` prints `deno X.Y.Z (…)`.
- **Timing:** yt-dlp `--version` takes about 0.43 s (brew), ffmpeg/ffprobe about 0.06 s, deno about 0.01 s.
- **Minimums:**
  - yt-dlp 2025.11.12, the first release with `--js-runtimes`. Older builds reject the option, so every real call would fail.
  - deno 2.3.0 and Node 22, from yt-dlp's `_jsruntime.py`.
  - ffmpeg and ffprobe 8.
- **`--js-runtimes`:** a bad `--js-runtimes node:/bad/path` is dropped silently. Always pass `process.execPath`, never a configurable string.
- **`--ffmpeg-location`:**
  - It takes the ffmpeg binary or a directory.
  - Given a binary, yt-dlp looks for ffprobe only beside it (`ffmpeg-8` → `ffprobe-8`, else `ffprobe`), never on PATH.
  - Pass it only when `FFMPEG_PATH` is set; otherwise yt-dlp searches PATH as we do.
- **`-v` without a URL** exits 2. For the `[debug] JS runtimes: …` header, add `--list-impersonate-targets` (exits 0). It's for diagnostics only; the format isn't stable.
