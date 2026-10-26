import { CircleAlert, RotateCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { describeError } from '@/lib/error-text.ts'

/** Title widths of the placeholder rows; each is distinct, so it doubles as the row's key. */
const ROW_WIDTHS = ['w-[58%]', 'w-[44%]', 'w-[66%]', 'w-[38%]']

/** The suggestions while the search runs (a few seconds): rows like the list's. */
export function RemixSkeleton() {
  return (
    <div aria-hidden data-slot="remix-skeleton" className="flex flex-col">
      {ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-16 items-center gap-3 border-b border-border/50">
          <Skeleton className="size-10 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  )
}

type RemixErrorProps = {
  error: unknown
  /** Try again is running. */
  retrying: boolean
  onRetry: () => void
}

/**
 * The whole search failed (the engine is missing, the title has no words to search for, the server
 * is down): the server's message, a next step, and Try again unless the request itself was refused.
 */
export function RemixError({ error, retrying, onRetry }: RemixErrorProps) {
  const failure = describeError(error)
  if (failure === undefined) return null
  return (
    <div className="flex flex-col gap-2">
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertTitle>Couldn't search for remixes</AlertTitle>
        <AlertDescription className="[&_p:not(:last-child)]:mb-1">
          <p>
            <ProblemText message={failure.message} />
          </p>
          {failure.hint !== undefined && (
            <p>
              <ProblemText message={failure.hint} />
            </p>
          )}
        </AlertDescription>
      </Alert>
      {failure.code !== 'invalid_request' && (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={retrying}
            focusableWhenDisabled
            onClick={onRetry}
          >
            <RotateCw aria-hidden className={retrying ? 'motion-safe:animate-spin' : undefined} />
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}
