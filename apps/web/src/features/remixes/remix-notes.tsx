import type { RemixPlatform } from '@dj-scraper/shared'
import { CircleAlert, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { cn } from '@/lib/utils.ts'
import { type SearchFailure, searchingText } from './remix-text.ts'

type RemixNotesProps = {
  /** Platforms whose search is still running (the quick answer skipped them). */
  searching: readonly RemixPlatform[]
  failures: readonly SearchFailure[]
  /** A search is running again. */
  retrying: boolean
  /** Searches the failed platforms again; the rows of the others stay. */
  onRetry: () => void
}

/**
 * Above the rows: "Searching SoundCloud…" while the quick answer shows (announced), and a note per
 * platform whose search failed, with Try again. The server caches only searches that succeeded,
 * so trying again searches the failed platform only.
 */
export function RemixNotes({ searching, failures, retrying, onRetry }: RemixNotesProps) {
  return (
    <>
      <p aria-live="polite" className="text-xs text-muted-foreground empty:hidden">
        {searching.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Spinner aria-hidden className="size-3" />
            {searchingText(searching)}
          </span>
        )}
      </p>
      {failures.length > 0 && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <ul className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {failures.map(({ platform, text }) => (
              <li key={platform} className="flex items-start gap-1.5">
                <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
                <span>
                  <ProblemText message={text} />
                </span>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="xs"
            disabled={retrying}
            focusableWhenDisabled
            onClick={onRetry}
          >
            <RotateCw aria-hidden className={cn(retrying && 'motion-safe:animate-spin')} />
            Try again
          </Button>
        </div>
      )}
    </>
  )
}
