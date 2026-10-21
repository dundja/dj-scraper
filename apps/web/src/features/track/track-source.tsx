import type { AudioSource } from '@dj-scraper/shared'
import { matchSite, sourceText } from '@/features/downloads/job-text.ts'
import { useJob } from '@/features/downloads/use-downloads.ts'

type TrackSourceProps = {
  /** What resolve found: the best audio stream yt-dlp would pick. */
  source: AudioSource | undefined
  /** The track's download, once queued. */
  jobId: string | undefined
  unavailable: boolean
}

/**
 * "Source: AAC 128 kbps". Once the download reports the stream it really fetched, that one: the
 * format can pick another stream than resolve's best guess (M4A takes YouTube's AAC over its Opus),
 * and the card must not name a source the file didn't come from. A Spotify track's stream is its
 * YouTube match's, and says so: "Source: YouTube AAC 128 kbps" (ADR-026).
 */
export function TrackSource({ source, jobId, unavailable }: TrackSourceProps) {
  const job = useJob(jobId)
  const text = sourceText(job?.source ?? source ?? {})
  const site = job === undefined ? undefined : matchSite(job)
  if (text !== '') return <span>Source: {site === undefined ? text : `${site} ${text}`}</span>
  return unavailable ? null : <span>Source quality shown after download</span>
}
