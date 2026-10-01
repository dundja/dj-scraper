# Product Spec

> One paste → DJ-ready audio files in the folder you want.

## Who it's for
One DJ on their own Mac, collecting tracks from YouTube and SoundCloud. Everything runs locally: no accounts, no cloud.

## Sources
| Source | v1 |
|---|---|
| YouTube: videos, Shorts, `youtu.be`, `music.youtube.com` | ✅ first-class |
| YouTube: playlists, YouTube Music albums, channel uploads | ✅ first-class |
| YouTube: Mix/Radio (`list=RD…`, endless) | ⚠️ single track by default; loading the mix is capped |
| SoundCloud: tracks, sets/playlists/albums, private links with a secret token | ✅ first-class |
| SoundCloud: a user's tracks / likes / reposts | ✅ as collections |
| Anything else yt-dlp supports (Bandcamp, Mixcloud, Vimeo, …) | best effort, generic normalization |
| DRM services (Spotify, Apple Music, Tidal, Deezer, Beatport streaming) | ❌ out of scope |

## Core flows

### 1. Paste a link
- Paste anywhere in the app (⌘V), drop a link, or type into the URL box.
- Instantly show the detected platform and a best guess (track or playlist) before the server answers.
- Resolve on the server, showing a skeleton meanwhile. Targets: a single track in under 3 s, and a 200-track YouTube playlist listed in under 10 s.
- A watch URL that also carries a playlist (`watch?v=…&list=…`) asks: **This track** or **Whole playlist**.

### 2. Single track → download immediately
- Show the track card: artwork, title, artist, duration, platform, and source quality (codec/bitrate when known).
- Start downloading right away into the current target folder with the default format. Cancelling takes one click.
- Setting: "Auto-download single tracks" (default on). When it's off, show a Download button instead.

### 3. Playlist → pick → download
- Header: artwork, title, owner, track count, total duration.
- Track list: checkbox, #, artwork, title, artist, duration, availability. All available tracks start selected.
- Selection:
  - select all / none / invert, and shift-click ranges
  - a text filter that keeps the selection
  - a live count and total duration of what's selected
- Unavailable entries (private, deleted, region-blocked) show greyed out with a reason and can't be selected.
- Stays smooth with 1,000+ tracks. SoundCloud sets list instantly; titles, durations and artwork fill in as rows load.
- One click on **Download N tracks** queues them into the target folder, optionally into a subfolder named after the playlist.

### 4. Target folder
- Always visible in the app header. It defaults to `~/Music/DJ Scraper` and remembers the last folder plus a few recent ones.
- **Change…** opens the native macOS folder picker (shown by the local server).

### 5. Download progress
- Each track moves from queued → downloading (percent, speed, ETA) → processing (convert, tag) → done. It can also end as failed, canceled, or skipped (already exists).
- A track may show **waiting** for a few seconds before it starts; YouTube enforces that delay.
- Big batches are paced to stay under platform rate limits (YouTube allows roughly 300 tracks/hour without a login). When a platform starts limiting, its queue pauses and resumes on its own.
- Batch controls: overall progress, cancel one or all, retry failed, and **Reveal in Finder** for finished files.
- One failing track never stops the batch.
- Errors are written for humans: "Private video", "Not available in your country", "Age-restricted: needs browser cookies", "Preview only (SoundCloud Go+)", …

### 6. Settings
- Format:
  - **MP3 320 kbps (default)**
  - M4A/AAC (no re-encode when the source is AAC)
  - AIFF: the lossless container to pick, since it keeps tags and artwork
  - WAV (no artwork, minimal tags) and FLAC
  - Original (no conversion; Opus/WebM files won't load in DJ apps)
- Filename template (default `{artist} - {title}`).
- Embed artwork (on). Write the source URL into the comment tag (on).
- Skip already-downloaded tracks (on).
- Parallel downloads (default 3).
- Auto-download single tracks (on).
- Sign-ins, all off by default: browser cookies for age-restricted YouTube videos, and a SoundCloud login for original files and Go+ streams.

## Quality: be honest
Every stream is lossy:
- YouTube: Opus at ~130–160 kbps or AAC at 128 kbps (256 kbps only with Premium cookies).
- SoundCloud without a login: AAC 160 kbps at best, otherwise MP3 128 kbps.
- SoundCloud originals (often WAV or FLAC) exist only when the uploader enables downloads, and fetching them needs a SoundCloud login.

Converting to MP3 320 or AIFF improves compatibility with DJ software, not quality. The UI shows the source codec and bitrate, and uses an original file whenever one is available.

## Metadata & files
- Tags: title, artist, album (when known), year, artwork, and the source URL in the comment.
- Artist/title come from platform metadata when present (YouTube Music, SoundCloud). Otherwise they're split from "Artist - Title" video titles. Noise like "(Official Video)", "[HD]" and "(Lyrics)" is cleaned up with a preview (Phase 4).
- SoundCloud Go+ tracks that only offer 30-second previews are flagged and never saved as if they were the full track.
- Filenames are safe on macOS and Windows. Existing files are never overwritten silently.

## Non-goals (v1)
- DRM-protected services, and paywalled or private content the user can't already access.
- Video downloads.
- Hosted, multi-user or mobile versions.
- Library management beyond "already downloaded" detection. DJ software does that.

## Responsible use
This is a personal tool. Download only what you have the right to: your own uploads, free downloads, Creative Commons, artist-permitted tracks. Respect each platform's terms and copyright.
