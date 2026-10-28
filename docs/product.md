# Product Spec

> One paste → DJ-ready audio files in the folder you want.

## Who it's for
One DJ on their own Mac, collecting tracks from YouTube and SoundCloud, and from Spotify lists matched on YouTube. Everything runs locally: no accounts, no cloud.

## Sources
| Source | v1 |
|---|---|
| YouTube: videos, Shorts, `youtu.be`, `music.youtube.com` | ✅ first-class |
| YouTube: playlists, YouTube Music albums, channel uploads | ✅ first-class |
| YouTube: Mix/Radio (`list=RD…`, endless) | ⚠️ single track by default; loading the mix is capped |
| SoundCloud: tracks, sets/playlists/albums, private links with a secret token | ✅ first-class |
| SoundCloud: a user's tracks / likes / reposts | ✅ as collections |
| Anything else yt-dlp supports (Bandcamp, Mixcloud, Vimeo, …) | best effort, generic normalization |
| Spotify: tracks, albums, playlists (`open.spotify.com`) | ✅ as track lists: names and covers from Spotify, the audio matched and downloaded on YouTube (ADR-026). A playlist link shows its first 100 tracks; pasting its track links lists them all (ADR-028) |
| Spotify's own streams, and other Spotify pages (artists, podcasts, `spotify.link` short links) | ❌ streams are DRM-protected and never downloaded; other pages refused by URL |
| DRM services (Apple Music, Amazon Music, Tidal, Deezer, Beatport streaming) | ❌ out of scope, refused by URL |

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

### 2b. Spotify links
- A Spotify track, album or playlist link loads like any other: a track gets the track card (and downloads at once), a list gets the track list to pick from. Spotify's page gives the names, durations and covers; no Spotify account is involved.
- Spotify's streams are DRM-protected, so each track's audio comes from YouTube: the download searches YouTube for the artists and title and takes the upload whose length agrees and that isn't another version (live, remix, cover, …). The card and the downloads panel show which upload it took, and the file is tagged with Spotify's title, artists, year and cover.
- The quality is YouTube's (see Quality), never dressed up: the source line shows the YouTube stream.
- When no upload matches, the track fails with "No YouTube upload matches", and pasting a YouTube or SoundCloud link of the track instead is the way out.
- Spotify's page lists only a playlist's first 100 tracks, and the list says so and how to get them all: in the Spotify desktop app, select every track of the playlist (⌘A), copy (⌘C) and paste. A paste or drop holding two or more Spotify track links loads as one list, "Pasted Spotify tracks", in the order they were pasted, each track once. Its rows fill in with names and durations as they scroll into view, and any row downloads, filled in or not (ADR-028). The paste box empties and says how many links it took.

### 2c. Remix suggestions
- Under a single track's card (YouTube, SoundCloud or Spotify), a **Remixes** section lists up to 20 remixes of the song found on YouTube and SoundCloud, most played first. The card and its auto-download work as before; the section never holds them up.
- What counts: another producer's remix, rework, flip, VIP or dub; bootlegs and someone else's edits; the original artist's extended or club mix. Covers, live takes, sped-up or slowed re-uploads, karaoke, mashups and hour-long loops don't. A pasted remix finds the song's other remixes.
- One row per version, even when it is uploaded on both platforms or by several channels: its title, who made it ("Remix by Arty", "Bootleg by X", "Extended mix"), a genre tag when one is known, a chip per platform with its views or plays, and the length.
- The genre comes from SoundCloud's genre field when the uploader set one, or from a genre the title, tags or description name ("afro house remix"); a named genre is shown as such, and none is guessed beyond the words. Chips above the list filter by genre.
- **Download** takes the version's most-played upload into the current folder and format, like any track; a menu picks another upload. The row then follows the job.
- YouTube's results show within a few seconds; SoundCloud's search can take ten, and its rows join the list when they arrive. A failed search on one platform leaves the other's rows and says why.
- SoundCloud's search spends a request from the same budget as SoundCloud lookups and downloads. Results are kept for 30 minutes, so pasting the song again searches nothing.

### 3. Playlist → pick → download
- Header: artwork, title, owner, track count ("50 of 214" when the list is cut), total duration ("≈" when some are unknown).
- A page that lists sets or playlists instead of tracks (a SoundCloud user's Sets or Albums tab, a YouTube channel's Playlists tab) shows them as links; opening one loads it.
- Track list: checkbox, #, artwork, title, artist, duration, availability. All available tracks start selected. A track listed twice is one track: selected together, downloaded once.
- Selection:
  - select all / none / invert, and shift-click ranges
  - a text filter that keeps the selection
  - **Hide downloaded**, with the number of rows it hides: tracks whose latest download is Done or In folder leave the table and the download, so only the new ones go out. Their checks are kept for when it is turned off, and a track that finishes while it is on leaves by itself. It knows the downloads the server still holds (since it started)
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
- Errors are written for humans: "Private video", "Not available in your country", "Age-restricted: needs browser cookies", "Preview only (SoundCloud Go+)", "No YouTube upload matches this Spotify track", …

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
- Spotify links download their YouTube match, so they are YouTube's quality. Spotify's own streams (Ogg Vorbis up to ~320 kbps, lossless on Premium) are DRM-protected and never downloaded; compare them by ear in the Spotify app.

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
