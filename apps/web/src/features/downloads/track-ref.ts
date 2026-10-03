import {
  type CollectionEntry,
  type DownloadOptions,
  MAX_SUBFOLDER_LENGTH,
  MAX_TRACK_TEXT_LENGTH,
  MAX_URL_LENGTH,
  type Platform,
  type Settings,
  type Track,
  type TrackRef,
} from '@dj-scraper/shared'
import { clipText } from '@/lib/format.ts'

/**
 * A track to download, as `POST /api/downloads` takes it: the fields TrackRef allows, so neither a
 * collection row's `partial` nor the stream's `source`. Text the contract caps (titles can be any
 * length) is clipped, and an over-long artwork URL is left out: these fields are for display.
 */
export function toTrackRef(track: Track | CollectionEntry): TrackRef {
  const ref: TrackRef = { platform: track.platform, id: track.id, url: track.url }
  if (track.title !== undefined) ref.title = clipText(track.title, MAX_TRACK_TEXT_LENGTH)
  if (track.artist !== undefined) ref.artist = clipText(track.artist, MAX_TRACK_TEXT_LENGTH)
  if (track.uploader !== undefined) ref.uploader = clipText(track.uploader, MAX_TRACK_TEXT_LENGTH)
  if (track.durationSec !== undefined) ref.durationSec = track.durationSec
  if (track.thumbnailUrl !== undefined && track.thumbnailUrl.length <= MAX_URL_LENGTH) {
    ref.thumbnailUrl = track.thumbnailUrl
  }
  ref.availability = track.availability
  if (track.unavailableReason !== undefined) ref.unavailableReason = track.unavailableReason
  return ref
}

/** Identifies a track across collections, jobs and refs: `youtube:dQw4w9WgXcQ`. */
export type TrackKey = `${Platform}:${string}`

/** The key of a track, a collection row, a TrackRef or a job's `track`. */
export function trackKey(track: { platform: Platform; id: string }): TrackKey {
  return `${track.platform}:${track.id}`
}

/**
 * The download options the settings call for, plus the subfolder for a list (e.g. its title;
 * the server makes one safe folder name of it). A blank subfolder is left out, a long one clipped.
 */
export function downloadOptionsFrom(settings: Settings, subfolder?: string): DownloadOptions {
  const options: DownloadOptions = {
    format: settings.format,
    filenameTemplate: settings.filenameTemplate,
    embedArtwork: settings.embedArtwork,
    sourceUrlComment: settings.sourceUrlComment,
  }
  const folder = subfolder?.trim()
  if (folder !== undefined && folder !== '') {
    options.subfolder = clipText(folder, MAX_SUBFOLDER_LENGTH)
  }
  return options
}
