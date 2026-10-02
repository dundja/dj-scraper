# yt-dlp reference notes

Supporting detail for [SKILL.md](SKILL.md), verified 2026-10-01 against yt-dlp stable 2026.08.19 and nightly 2026.09.27. `#N` refers to github.com/yt-dlp/yt-dlp/issues/N.

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
| `hls_opus_0_0` | Opus 64 kbps |
| `hls_aac_256k` | AAC 256 kbps (Go+) |
| `download` | Uploader's original (wav/flac/mp3…). Needs downloads enabled **and** a login (HTTP 401 otherwise). Ranked first. Rate-limited: after ~10 tracks it silently falls back (#15093). |
| `*_preview` | 30-second previews of Go+-only tracks |

**SoundCloud access:**
- **Login:** `--cookies-from-browser`, which reads the `oauth_token` cookie. `--username oauth --password <token>` also works, but don't use it: argv is visible in `ps`.
- **API budget:** about 600 requests per 10 min.
- **Paged lists** (users, likes) need curl-cffi browser impersonation, which brew and the onefile binary bundle.

## Conversion & tagging
- **`-x --audio-format`:** best, aac, alac, flac, m4a, mp3, opus, vorbis, wav. There is no aiff. AAC → m4a is a copy.
- **`--audio-quality`:**
  - Values above 10 are CBR: `320K` becomes `-b:a 320k`.
  - 0–10 is VBR for mp3/vorbis/aac (0 = LAME V0).
  - **The default is 5, i.e. LAME V5 at about 130 kbps.**
  - It's ignored for opus, flac, alac, wav and copies.
- **ALAC:** since a 2022 refactor, `--audio-format alac` may produce AAC (from reading the code, untested). Verify with ffprobe.
- **`--embed-metadata`:** artist comes from artist, then artists, creator, uploader. Title comes from track, then title.
- **`--embed-thumbnail`** works for mp3, m4a/mp4, flac, opus/ogg and mkv/mka, and errors on WAV and AIFF. webp art is converted to png automatically; add `--convert-thumbnails jpg` for JPEG.
- **Splitting "Artist - Title":** the README's `--parse-metadata "title:%(artist)s - %(title)s"` is greedy and splits at the last " - ". The non-greedy regex is `"title:(?P<artist>.+?)\s+[-–—]\s+(?P<title>.+)"`. A non-match only logs "Could not interpret". These options apply in order.

## Files & paths
- **Locations:** `-P home:<dir> -P temp:<dir>`, plus `-o` templates with fallbacks such as `%(artist,uploader)s`.
- **Filename sanitizing:**
  - By default `"*:<>?|/\` become full-width lookalikes.
  - `--windows-filenames` adds Windows rules; `--restrict-filenames` allows ASCII only; `--trim-filenames N` caps the length.
- **Overwrites:** existing files aren't overwritten by default. `-w`/`--no-overwrites` skips every existing file; `--force-overwrites` implies `--no-continue`.
- **Archive:** `--download-archive FILE` appends `<extractor> <id>` after each success. Archived items print nothing with `--print`.
- **Network:**
  - `-N 4` (concurrent fragments) helps HLS (SoundCloud), not YouTube.
  - Retries default to `-R 10 --fragment-retries 10`; `--retry-sleep exp=1:30` adds back-off.

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
- **`--encoding utf-8`:** without it, characters that don't fit the stream encoding are silently dropped.

## Process control
- **Exit codes:**
  - 0: ok
  - 1: any error. Playlists continue past failures but still exit 1; Ctrl-C also exits 1.
  - 2: option error
  - 100: update failed
  - 101: `--max-downloads` or a `--break-*` limit was reached
- **Signals:** SIGINT also stops yt-dlp's ffmpeg child; there is no SIGTERM handler.
- **Leftover files:** `.part`, `.part-FragN`, `.ytdl`, `.temp.*` and thumbnails.
- **Onefile binary:** whether it forwards signals to its child is unverified, so prefer the process-group kill.

## ffmpeg
- **Needed for:** `-x` (ffmpeg and ffprobe), container fix-ups (YouTube m4a, SoundCloud AAC), `--embed-metadata`, thumbnail conversion, MP3 cover art, remux/recode.
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
- **WAV vs AIFF:** ffmpeg writes only basic RIFF INFO tags and no artwork to WAV, and rekordbox users report missing WAV artwork. AIFF carries ID3v2 tags plus a cover (`-write_id3v2 1`).

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
