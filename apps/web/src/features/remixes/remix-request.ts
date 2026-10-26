import {
  MAX_TRACK_TEXT_LENGTH,
  MAX_URL_LENGTH,
  type RemixRequest,
  type RemixUpload,
  type Track,
  type TrackRef,
} from '@dj-scraper/shared'
import { clipText } from '@/lib/format.ts'

/**
 * What `POST /api/remixes` takes for a resolved track: its names as resolve showed them (the server
 * takes the song out of them), clipped to the contract's cap, and the track itself to leave out.
 * Built for any track, an unavailable one too: its remixes may well be downloadable.
 */
export function remixRequestFor(track: Track): RemixRequest {
  const request: RemixRequest = {
    title: clipText(track.title, MAX_TRACK_TEXT_LENGTH),
    exclude: { platform: track.platform, id: track.id },
  }
  if (track.artist !== undefined) request.artist = clipText(track.artist, MAX_TRACK_TEXT_LENGTH)
  if (track.uploader !== undefined) {
    request.uploader = clipText(track.uploader, MAX_TRACK_TEXT_LENGTH)
  }
  return request
}

/**
 * A remix upload as `POST /api/downloads` takes it, like `toTrackRef` makes one of a track: its
 * page, names, length and artwork (for display; text clipped, an over-long artwork URL left out).
 * Its availability is unknown until the download looks.
 */
export function uploadRef(upload: RemixUpload): TrackRef {
  const ref: TrackRef = {
    platform: upload.platform,
    id: upload.id,
    url: upload.url,
    title: clipText(upload.title, MAX_TRACK_TEXT_LENGTH),
  }
  if (upload.uploader !== undefined) ref.uploader = clipText(upload.uploader, MAX_TRACK_TEXT_LENGTH)
  if (upload.durationSec !== undefined) ref.durationSec = upload.durationSec
  if (upload.thumbnailUrl !== undefined && upload.thumbnailUrl.length <= MAX_URL_LENGTH) {
    ref.thumbnailUrl = upload.thumbnailUrl
  }
  return ref
}
