import type { ResolveMode } from '@dj-scraper/shared'
import { PasteEmptyState } from './paste-empty-state.tsx'
import { ResolveError } from './resolve-error.tsx'
import { failureView, listFallback } from './resolve-failure.ts'
import { ResolveLoading } from './resolve-loading.tsx'
import { ResolvedResult } from './resolved-result.tsx'
import type { Resolver } from './use-resolve.ts'

type ResolveOutcomeProps = {
  resolver: Resolver
  /**
   * Loads a link the result or error points at (Try again too), showing it in the paste box, which
   * takes the focus.
   */
  onLoad: (url: string, mode: ResolveMode) => void
  /**
   * Puts the focus back in the paste box after a button here removed itself without loading
   * (Cancel, This track), so the keyboard doesn't fall back to the top of the page.
   */
  onFocusBox: () => void
}

/**
 * Everything under the paste box: the empty state, the loading skeleton, the error, or the result.
 * A new resolve replaces the last result with its skeleton (the downloads panel keeps the history).
 */
export function ResolveOutcome({ resolver, onLoad, onFocusBox }: ResolveOutcomeProps) {
  const { status, submission } = resolver
  if (submission === undefined) return <PasteEmptyState />

  switch (status) {
    case 'pending':
      return (
        <ResolveLoading
          key={submission.seq}
          submission={submission}
          startedAt={resolver.submittedAt}
          onCancel={() => {
            resolver.cancel()
            onFocusBox()
          }}
        />
      )
    case 'error': {
      const failure = failureView(resolver.error)
      // An abort shows nothing: Cancel or a newer paste did it.
      if (failure === undefined) return <PasteEmptyState />
      const { url, mode } = submission
      return (
        <ResolveError
          failure={failure}
          fallback={listFallback(url, mode, resolver.error)}
          // Through the page's load, so the box shows the link that loads again.
          onRetry={() => onLoad(url, mode)}
          onOpenList={() => onLoad(url, 'collection')}
        />
      )
    }
    case 'success':
      return resolver.result === undefined ? (
        <PasteEmptyState />
      ) : (
        <ResolvedResult
          key={submission.seq}
          result={resolver.result}
          onLoad={onLoad}
          onTrackChosen={onFocusBox}
        />
      )
    case 'idle':
      return <PasteEmptyState />
  }
}
