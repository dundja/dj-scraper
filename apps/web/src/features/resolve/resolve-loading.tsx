import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { cn } from '@/lib/utils.ts'
import { bigListNote, loadingLabel, SLOW_AFTER_SECONDS } from './resolve-text.ts'
import { ListSkeleton, TrackSkeleton } from './result-skeletons.tsx'
import { loadingShape, urlVerdict } from './url-verdict.ts'
import { useElapsedSeconds } from './use-elapsed-seconds.ts'
import type { Submission } from './use-resolve.ts'

type ResolveLoadingProps = {
  submission: Submission
  /** When the resolve started (ms since the epoch). */
  startedAt: number
  onCancel: () => void
}

/**
 * While a link resolves: a skeleton shaped like the likely result, and Cancel. A list that takes
 * more than a few seconds shows the seconds and why (YouTube lists 100 rows per request).
 */
export function ResolveLoading({ submission, startedAt, onCancel }: ResolveLoadingProps) {
  const shape = loadingShape(submission.url, submission.mode)
  const elapsed = useElapsedSeconds(startedAt)
  const slow = elapsed >= SLOW_AFTER_SECONDS
  const verdict = urlVerdict(submission.url)
  const platform = verdict.status === 'ok' ? verdict.platform : 'other'

  return (
    // A list spans the column, as the collection it turns into does; a track card doesn't.
    <div
      aria-busy="true"
      data-shape={shape}
      className={cn('flex w-full flex-col gap-3 px-4 pb-6', shape !== 'list' && 'max-w-3xl')}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <Spinner aria-hidden />
        <span>{loadingLabel(shape)}</span>
        {/* Not live: announcing every second would drown out everything else. */}
        {slow && <span className="tabular-nums">{elapsed} s</span>}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {slow && shape === 'list' && (
        <p className="-mt-1 text-xs text-muted-foreground">{bigListNote(platform)}</p>
      )}
      {shape === 'list' ? <ListSkeleton /> : <TrackSkeleton />}
    </div>
  )
}
