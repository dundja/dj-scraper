# ffprobe fixtures

Recorded 2026-10-02 on macOS 26.5.1 (arm64) with Homebrew ffmpeg/ffprobe **8.0** (`8.0_1`). Each `<name>.json` is the stdout of one ffprobe call, then `biome format`. The probed files are real: the sources are what the yt-dlp 2026.08.19 runs in `../downloads/` left in their job dirs, and the outputs were made from those sources with the Phase 2 design's finalize recipes (D3, D14). No media files are kept.

How they are used:
- `src/engine/finalize-plan.test.ts` parses every file with `parseProbe` and checks the planning and readback rules against them. Its `PROBES` table has an expectation per file, a meta-test fails when a file has none, and another checks that this README's `-show_entries` matches finalize's `PROBE_ENTRIES`.
- `../../fake-ffmpeg.mjs` (the fake ffprobe) answers with the JSON named in a fake media file's header: `src-*` for what the fake yt-dlp downloads, `out-*` for what the fake ffmpeg writes, `cover-*` for covers. `test/fake-ffmpeg.test.ts` checks it against these files.
- A new file needs a `PROBES` entry.

```
ffprobe -v error -show_entries format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic -of json <file>
```
- ffprobe prints most values as **strings** (`"sample_rate": "48000"`, `"duration": "19.021000"`, `"bit_rate": "320000"`); `index` and `channels` are numbers. Missing values are left out (an Opus or FLAC stream has no `bit_rate`, an image no `sample_rate`). `programs` and `stream_groups` are always present and empty.
- The output holds no paths (no `filename` entry is requested). A path would be replaced by `{JOBDIR}`; none occurred.
- Tag keys keep each container's case: WebM gives `title` but `ARTIST`, `COMMENT`, `ENCODER`; MP4, FLAC and WAV give lower case.

## Sources (as yt-dlp left them)
| File | From | What it shows |
|---|---|---|
| `src-youtube-251-webm.json` | `youtube-ba` (`jNQXAC9IVRw.webm`) | `matroska,webm`, 19.021 s, 106 kbps; Opus 48 kHz 2 ch, no stream `bit_rate`; tags `encoder=google/video-file`, stream `language=eng` |
| `src-youtube-140-m4a.json` | `youtube-m4a` (after FixupM4a) | `mov,mp4,…`, 19.064 s; AAC 44.1 kHz 2 ch 128 kbps; brand `isom`, `encoder=Lavf62.3.100` (yt-dlp's fixup remux) |
| `src-soundcloud-mp3.json` | `soundcloud-ba` (`http_mp3_0_0`) | `mp3`, 9.874 s (DONE says 9.927); MP3 44.1 kHz 2 ch 128 kbps; no format tags, stream tag `encoder=LAME3.99r` (from the LAME header). The `soundcloud-hls` file is byte-identical, so this covers `hls_mp3_0_0` too |
| `src-soundcloud-hls-aac-m4a.json` | `soundcloud-hls-aac` (`hls_aac_160k`, after FixupM4a + FixupM3u8) | `mov,mp4,…`, 221.872 s; AAC 44.1 kHz 2 ch 160 kbps; brand `isom` |
| `src-youtube-251-webm-part.json` | `youtube-cancel-download` (`jNQXAC9IVRw.webm.part`, 64,512 of 252,182 bytes) | A **truncated** WebM probes with the full declared duration, **19.021 s**; only the format `bit_rate` (27 kbps, size ÷ duration) gives it away |
| `src-mp3-vbr-noxing.json` | **not a download**: made 2026-10-03 with `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo:d=120 -f lavfi -i anoisesrc=d=480:c=pink:r=44100:a=0.3 -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" -ac 2 -c:a libmp3lame -q:a 0 -write_xing 0 vbr-noxing.mp3` (9,653,659 B), what a podcast host's VBR MP3 without a Xing/Info header looks like | A **600 s** file probes as **2,413.40 s**: without a Xing header the mp3 demuxer estimates the duration from the first (silent, 32 kbps) frame; `-v warning` adds `Estimating duration from bitrate, this may be inaccurate`. Measuring it (`ffmpeg … -i <file> -map 0:a:0 -c:a copy -f null -` with `-progress pipe:1`) gives `out_time_us=600032653`. The noise differs per run, so a re-recording gives another estimate |

## Finalize outputs
Each pass ran in a fresh job dir holding copies of yt-dlp's files under their yt-dlp names; outputs use the fixed names `out.<ext>` and `cover.jpg`. Every pass exited 0. Shorthands (expand them to get the exact argv):
- **HEAD** = `ffmpeg -hide_banner -nostdin -loglevel error -n`
- **IN(f)** = `-protocol_whitelist file -i {JOBDIR}/f`; **COVER** = `-protocol_whitelist file -f jpeg_pipe -i {JOBDIR}/cover.jpg`
- **PIC** = `-c:v copy -disposition:v:0 attached_pic -metadata:s:v:0 'title=Album cover' -metadata:s:v:0 'comment=Cover (front)'`
- **YT-TAGS** = `-map_metadata -1 -metadata 'title=Me at the zoo' -metadata artist=jawed -metadata comment=https://www.youtube.com/watch?v=jNQXAC9IVRw`
- **SC-TAGS** = `-map_metadata -1 -metadata 'title=Knocked Up' -metadata 'artist=The Royal Concept' -metadata comment=https://soundcloud.com/the-concept-band/knocked-up-mastered`
- **SECRET-TAGS** = `-map_metadata -1 -metadata "title=Dl Test Video '' Ä↭" -metadata artist=Youtube` (the secret test track: `Ä` is `A` + U+0308; no comment, because the input URL is a secret link, D2)
- **SCALE** = `-vf "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease"`

| File | Source | Plan | argv | Result |
|---|---|---|---|---|
| `cover-youtube-webp.json` | `jNQXAC9IVRw.webp` (480×360) | cover (D3) | HEAD `-xerror -protocol_whitelist file -f webp_pipe -i {JOBDIR}/jNQXAC9IVRw.webp -map 0:v:0 -frames:v 1` SCALE `-c:v mjpeg -q:v 2 -pix_fmt yuvj420p -f image2 -update 1 {JOBDIR}/cover.jpg` | `image2`/`mjpeg`, 480×360 (not scaled up), 41,428 B baseline |
| `cover-soundcloud-jpg.json` | `47127631.jpg` (1500×1500, 1.8 MB) | cover (D3) | the same with `-f jpeg_pipe -i {JOBDIR}/47127631.jpg` | 1000×1000, 171,221 B baseline |
| `out-mp3-copy.json` | SC mp3 | mp3: copy (MP3 source) | HEAD IN(`123998367.mp3`) `-map 0:a:0 -vn -c:a copy -map_metadata -1 -id3v2_version 0 -write_id3v1 0 -f mp3 {JOBDIR}/out.mp3` | MP3 128k 44.1 kHz, 9.874 s, same size as the source; **no tags** (stream `encoder=Lavf` is the rewritten Xing/LAME header) |
| `out-mp3-encode.json` | YT webm | mp3: libmp3lame 320k | HEAD `-xerror` IN(`jNQXAC9IVRw.webm`) `-map 0:a:0 -vn -c:a libmp3lame -b:a 320k -map_metadata -1 -id3v2_version 0 -write_id3v1 0 -f mp3 {JOBDIR}/out.mp3` | MP3 320k at the native 48 kHz, 19.006 s; **no tags** (stream `encoder=Lavc62.11`) |
| `out-mp3-encode-truncated.json` | the truncated `.webm.part` (copied as `jNQXAC9IVRw.webm`) | as `out-mp3-encode` | as `out-mp3-encode` | **exit 0 despite `-xerror`** (stderr `[matroska,webm @ …] File ended prematurely` + the Opus line); **4.834 s** against the input's probed 19.021 s |
| `out-m4a-copy.json` | YT m4a | m4a: copy (AAC) + cover | HEAD IN(`jNQXAC9IVRw.m4a`) COVER `-map 0:a:0 -map 1:v:0 -c:a copy` PIC YT-TAGS `-movflags +faststart -f ipod {JOBDIR}/out.m4a` | brand `M4A `, AAC 128k copied, 19.064 s; tags title/artist/comment/encoder; stream 1 `mjpeg` `attached_pic: 1` (no stream tags in MP4) |
| `out-m4a-copy-soundcloud.json` | SC AAC m4a | m4a: copy + cover | HEAD IN(`47127631.m4a`) COVER `-map 0:a:0 -map 1:v:0 -c:a copy` PIC SC-TAGS `-movflags +faststart -f ipod {JOBDIR}/out.m4a` | AAC 160k copied, 221.872 s, cover `attached_pic: 1` |
| `out-m4a-encode.json` | SC mp3 | m4a: aac 256k (no cover: the SC thumbnail is the placeholder) | HEAD `-xerror` IN(`123998367.mp3`) `-map 0:a:0 -vn -c:a aac -b:a 256k` SECRET-TAGS `-movflags +faststart -f ipod {JOBDIR}/out.m4a` | AAC ~219 kbps (the encoder's real rate for this 10 s file), 9.874 s; title/artist, no comment |
| `out-flac.json` | YT webm | flac: s16 + cover | HEAD `-xerror` IN(`jNQXAC9IVRw.webm`) COVER `-map 0:a:0 -map 1:v:0 -c:a flac -sample_fmt s16` PIC YT-TAGS `-f flac {JOBDIR}/out.flac` | FLAC 48 kHz, 19.006 s; tags title/artist/comment (written as `DESCRIPTION`, read back as `comment`); stream 1 `mjpeg` `attached_pic: 1` with stream tags `title=Album cover`, `comment=Cover (front)` |
| `out-wav.json` | YT webm | wav: pcm_s16le | HEAD `-xerror` IN(`jNQXAC9IVRw.webm`) `-map 0:a:0 -vn -c:a pcm_s16le` YT-TAGS `-f wav {JOBDIR}/out.wav` | PCM s16le 48 kHz, 19.006 s; tags title/artist/comment (INFO `ICMT`) |
| `out-aiff.json` | YT webm | aiff: pcm_s16be | HEAD `-xerror` IN(`jNQXAC9IVRw.webm`) `-map 0:a:0 -vn -c:a pcm_s16be -map_metadata -1 -write_id3v2 0 -f aiff {JOBDIR}/out.aiff` | PCM s16be 48 kHz, 19.006 s; **no tags** |
| `out-original-webm.json` | YT webm | original: copy into webm | HEAD IN(`jNQXAC9IVRw.webm`) `-map 0:a:0 -vn -c:a copy` YT-TAGS `-f webm {JOBDIR}/out.webm` | Opus copied, 19.028 s; tags `title`, `ARTIST`, `COMMENT`, `ENCODER`; stream tag `DURATION` |

- **MP3 and AIFF outputs carry no tags on purpose** (D2: `-map_metadata -1`, no `-metadata`, `-id3v2_version 0` / `-write_id3v2 0`). Their tags and cover (TIT2, TPE1, TALB, TPE2, TYER, COMM, APIC) come from our own ID3v2.3 writer in a later step, which these fixtures don't include.
- Every pass that reads the YouTube Opus WebM (copy passes too) prints `[opus @ 0x…] Error parsing Opus packet header.` on stderr and still exits 0 with correct output.
- Decoded outputs from the Opus source last 19.006 s against 19.021 s probed and 19 s in DONE.
- **`-vn` drops a mapped cover.** Adding `-vn` to the m4a or flac cover argv (`-map 0:a:0 -map 1:v:0 -vn …`) also exits 0, but the output has no video stream at all. The recordings above pass `-vn` only where no cover is mapped; finalize itself never passes it, since `-map 0:a:0` already leaves video out.
