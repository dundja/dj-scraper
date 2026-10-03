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
| DRM services (Spotify, Apple Music, Amazon Music, Tidal, Deezer, Beatport streaming) | ❌ out of scope, refused by URL |

## Core flows

### 1. Paste a link
- Paste anywhere in the app (⌘V, outside other text fields), drop a link, or type into the URL box. Pasting a link loads it at once; a new link cancels the one still loading.
- Instantly show the detected platform and a best guess (track or playlist) before the server answers.
- Resolve on the server, showing a skeleton meanwhile, with Cancel. After 3 s it shows the seconds elapsed, and a list says that big ones take a while (on YouTube, 5,000 videos ≈ 1 min). Targets: a single track in under 3 s, and a 200-track YouTube playlist listed in under 10 s.
- A watch URL that also carries a playlist (`watch?v=…&list=…`) asks: **This track** or **Whole playlist** (or **Whole album**). For a mix the track is the default, and the mix loads only its first 50. If the track itself can't be loaded (private, age-restricted…), the error still offers the list.

### 2. Single track → download immediately
- Show the track card: artwork, title, artist, duration, platform, and source quality (codec/bitrate when known; once the download starts, the stream it actually took).
- Start downloading right away into the current target folder with the default format. The card then follows the download (queued, waiting, progress, done with what was written) with one button: Cancel, Retry or Reveal in Finder. Cancelling takes one click.
- Setting: "Auto-download single tracks" (default on). When it's off, show a Download button instead.

### 3. Playlist → pick → download
- Header: artwork, title, owner, track count ("50 of 214" when the list is cut), total duration ("≈" when some are unknown).
- A page that lists sets or playlists instead of tracks (a SoundCloud user's Sets or Albums tab, a YouTube channel's Playlists tab) shows them as links; opening one loads it.
- Track list: checkbox, #, artwork, title, artist, duration, availability. All available tracks start selected. A track listed twice is one track: selected together, downloaded once.
- Selection:
  - select all / none / invert, and shift-click ranges
  - a text filter that keeps the selection
  - a live count and total duration of what's selected
- Unavailable entries (private, deleted, region-blocked) show greyed out with a reason and can't be selected.
- Stays smooth with 1,000+ tracks. Lists of up to 5,000 rows load whole, and longer ones show their first 5,000 and say so (a mix shows its first 50). SoundCloud sets list instantly; titles, durations and artwork fill in as rows load, paced to stay within SoundCloud's request budget.
- One click on **Download N tracks** queues them into the target folder (shown in the bar, changed in the header), in the chosen format, optionally into a subfolder named after the playlist.

### 4. Target folder
- Always visible in the app header. It defaults to `~/Music/DJ Scraper` and remembers the last folder plus a few recent ones.
- **Choose folder…** opens the native macOS folder picker (shown by the local server).
- Only the default folder is created when missing; a folder you name must exist. A folder is checked when you choose it, picked or from the recent ones: a missing or unusable one is refused then, and macOS asks for access to a protected folder (Desktop, Documents, Downloads, iCloud Drive, a USB or network drive) at that moment, not in the middle of a batch. If it disappears during a batch (renamed, drive unplugged), its remaining tracks fail with that reason instead of recreating it.

### 5. Download progress
- Each track moves from queued → downloading (percent, speed, ETA) → processing (convert, tag) → done. It can also end as failed, canceled, or skipped (a file of that name is already there).
- A track may show **waiting** before its download starts, with the time it waits until; YouTube enforces that delay.
- Big batches are paced to stay under platform rate limits (YouTube allows roughly 300 tracks/hour without a login; SoundCloud downloads share their budget with filling in set rows). When a platform starts limiting, its queue shows **paused** until a given time, the track that hit the limit goes back to the front, and the queue resumes on its own.
- Each finished track says what was written: format, bitrate, and whether the stream was copied as is or re-encoded.
- The downloads panel stays beside the page: counts, overall progress, each batch with its folder and format, and every track's status.
- Batch controls: cancel one or all, retry failed, clear finished (for one batch or all), and **Reveal in Finder** for finished files.
- One failing track never stops the batch.
- Errors are written for humans: "Private video", "Not available in your country", "Age-restricted: needs browser cookies", "Preview only (SoundCloud Go+)", …

### 6. Settings
- Format:
  - **MP3 (default)**: 320 kbps when re-encoded; an MP3 source keeps its bitrate (often 128 kbps on SoundCloud), because re-encoding it could only lose quality
  - M4A/AAC: copied when the source is AAC; anything else is transcoded to AAC 256 kbps
  - AIFF: the lossless container to pick, since it keeps tags and artwork
  - WAV (no artwork, minimal tags) and FLAC (16-bit)
  - Original (no conversion). From YouTube that's Opus/WebM, which DJ apps won't load and which gets no artwork; SoundCloud's MP3 or AAC keeps its artwork
- Filename template (default `{artist} - {title}`).
- Embed artwork (on). Write the source URL into the comment tag (on): the track's public page only, never a secret, short or unlisted link.
- Skip already-downloaded tracks (on).
- Parallel downloads (default 3).
- Auto-download single tracks (on).
- Sign-ins, all off by default: browser cookies for age-restricted YouTube videos, and a SoundCloud login for original files and Go+ streams.

## Quality: be honest
Every stream is lossy:
- YouTube: Opus at ~130–160 kbps or AAC at 128 kbps (256 kbps only with Premium cookies).
- SoundCloud without a login: AAC 160 kbps at best, otherwise MP3 128 kbps.
- SoundCloud originals (often WAV or FLAC) exist only when the uploader enables downloads, and fetching them needs a SoundCloud login.

Converting to MP3 320 or AIFF improves compatibility with DJ software, not quality. The UI shows the source codec and bitrate, and uses an original file whenever one is available. Every finished file reports what it really is, read back from the file: an MP3 source is never re-encoded to look like "320", and an M4A made from a non-AAC source is marked as re-encoded.

## Metadata & files
- Tags: title, artist, album and year (when the platform has release data; never the upload date), artwork, and the source URL in the comment.
- The comment holds the track's public page on YouTube or SoundCloud. A SoundCloud secret link, a short link or an unlisted video gets no comment, so a shared file never leaks a private link. Other sites get none either.
- Artist/title come from platform metadata when present (YouTube Music, SoundCloud). Otherwise they're split from "Artist - Title" video titles, and failing that the uploader is the artist (without YouTube's " - Topic"). Noise like "(Official Video)", "[HD]" and "(Lyrics)" is cleaned up with a preview (Phase 4).
- SoundCloud Go+ tracks that only offer 30-second previews are flagged and never saved as if they were the full track.
- Filenames are safe on macOS, Windows and FAT/exFAT USB sticks. An existing file of the same name, in any letter case, is never overwritten: the track is skipped and your file stays as it was.

## Non-goals (v1)
- DRM-protected services, and paywalled or private content the user can't already access.
- Video downloads.
- Hosted, multi-user or mobile versions.
- Library management beyond "already downloaded" detection. DJ software does that.

## Responsible use
This is a personal tool. Download only what you have the right to: your own uploads, free downloads, Creative Commons, artist-permitted tracks. Respect each platform's terms and copyright.
