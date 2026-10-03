import type { AmbiguousListKind } from '@dj-scraper/shared'
import { CircleAlert, RotateCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import type { FailureView } from './resolve-failure.ts'
import { ambiguousWording } from './resolve-text.ts'

type ResolveErrorProps = {
  failure: FailureView
  /** A track-in-a-list link whose track failed: its list may still load. */
  fallback: AmbiguousListKind | undefined
  onRetry: () => void
  onOpenList: () => void
}

/** A link that didn't load: the server's message, a next step, Try again. */
export function ResolveError({ failure, fallback, onRetry, onOpenList }: ResolveErrorProps) {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-3 px-4 pb-6">
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertTitle>{failure.title}</AlertTitle>
        {(failure.detail !== undefined || fallback !== undefined) && (
          <AlertDescription className="[&_p:not(:last-child)]:mb-1">
            {failure.detail !== undefined && (
              <p>
                <ProblemText message={failure.detail} />
              </p>
            )}
            {fallback !== undefined && <p>The {fallback} itself may still load.</p>}
          </AlertDescription>
        )}
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onRetry}>
          <RotateCw aria-hidden />
          Try again
        </Button>
        {fallback !== undefined && (
          <Button variant="secondary" onClick={onOpenList}>
            {ambiguousWording(fallback).openList}
          </Button>
        )}
      </div>
    </div>
  )
}
