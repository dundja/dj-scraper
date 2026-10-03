import type { AudioSource } from '@dj-scraper/shared'
import { sourceText } from '@/features/downloads/job-text.ts'
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
 * and the card must not name a source the file didn't come from.
 */
export function TrackSource({ source, jobId, unavailable }: TrackSourceProps) {
  const job = useJob(jobId)
  const text = sourceText(job?.source ?? source ?? {})
  if (text !== '') return <span>Source: {text}</span>
  return unavailable ? null : <span>Source quality shown after download</span>
}
