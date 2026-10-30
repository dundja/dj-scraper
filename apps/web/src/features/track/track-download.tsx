import type { Track } from '@dj-scraper/shared'
import { CircleAlert, CircleSlash, Download } from 'lucide-react'
import { type ReactNode, useCallback, useId, useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Kbd } from '@/components/ui/kbd.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { JobInline } from '@/features/downloads/job-inline.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { FormatSelect } from '@/features/settings/format-select.tsx'
import { describeError, errorHint, unavailableLabel } from '@/lib/error-text.ts'
import { useDownloadShortcut } from './use-download-shortcut.ts'
import type { TrackDownloadState } from './use-track-download.ts'

type TrackDownloadProps = { track: Track; download: TrackDownloadState }

/**
 * The track card's download (queued by useTrackDownload): a Download button with the format beside
 * it, and ⌘D for the same while it shows (ADR-031); "Adding to downloads…" while the server answers.
 * Then the job's live status and actions; "Download again" queues a new job when the old one can't
 * be retried or is gone. An unavailable track only says why.
 */
export function TrackDownload({ track, download }: TrackDownloadProps) {
  const { jobId, start, status, error } = download
  const area = useRef<HTMLDivElement>(null)
  // Download, Try again and Download again each go as the download is added: the focus moves to
  // the download's area first, so it stays in the card (Tab goes on to the job's action) instead
  // of falling to the page's start.
  const startByUser = useCallback(() => {
    area.current?.focus()
    start()
  }, [start])
  // ⌘D moves the focus only off the button that goes: from the link box or a remix row it stays.
  const startByShortcut = useCallback(() => {
    if (area.current?.contains(document.activeElement)) area.current.focus()
    start()
  }, [start])
  const canStart =
    track.availability !== 'unavailable' && jobId === undefined && status !== 'pending'
  useDownloadShortcut(canStart ? startByShortcut : undefined)

  if (track.availability === 'unavailable') return <Unavailable track={track} />
  let content: ReactNode
  if (jobId !== undefined) {
    content = <JobInline key={jobId} jobId={jobId} onDownloadAgain={startByUser} />
  } else if (status === 'pending') {
    content = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden />
        Adding to downloads…
      </p>
    )
  } else {
    content = <StartDownload onStart={startByUser} error={status === 'error' ? error : null} />
  }
  return (
    <div
      ref={area}
      tabIndex={-1}
      data-slot="track-download"
      className="-m-1 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </div>
  )
}

/**
 * Along the card's bottom: on the left that nothing is downloaded yet, or why the last try failed
 * ("Try again"); on the right the Download button and the format.
 */
function StartDownload({ onStart, error }: { onStart: () => void; error: Error | null }) {
  const formatId = useId()
  const failure = error === null ? undefined : describeError(error)
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      {failure === undefined ? (
        <p className="text-xs text-muted-foreground">Not downloaded yet.</p>
      ) : (
        <div role="alert" className="flex min-w-0 items-start gap-2 text-sm">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-destructive">{failure.message}</p>
            {failure.hint !== undefined && (
              <p className="text-xs text-muted-foreground">
                <ProblemText message={failure.hint} />
              </p>
            )}
          </div>
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button onClick={onStart} aria-keyshortcuts="Meta+D">
          <Download aria-hidden />
          {failure === undefined ? 'Download' : 'Try again'}
          <Kbd aria-hidden className="bg-primary-foreground/15 text-primary-foreground">
            ⌘D
          </Kbd>
        </Button>
        <Label htmlFor={formatId} className="sr-only">
          Format
        </Label>
        <FormatSelect id={formatId} />
      </div>
    </div>
  )
}

function Unavailable({ track }: { track: Track }) {
  const hint =
    track.unavailableReason === undefined ? undefined : errorHint(track.unavailableReason)
  return (
    <div className="flex items-start gap-3 text-sm">
      <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{unavailableLabel(track.unavailableReason)}</p>
        <p className="text-muted-foreground">This track can't be downloaded.</p>
        {hint !== undefined && (
          <p className="text-xs text-muted-foreground">
            <ProblemText message={hint} />
          </p>
        )}
      </div>
    </div>
  )
}
