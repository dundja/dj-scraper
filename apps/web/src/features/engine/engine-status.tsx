import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { EngineDetails, type Recheck } from './engine-details.tsx'
import { CheckingMessage, OfflineMessage, UnexpectedMessage } from './engine-messages.tsx'
import { type EngineState, engineState, statusText, summarize } from './engine-state.ts'
import { EngineStateIcon } from './status-icon.tsx'
import { useHealth, useRecheckHealth } from './use-health.ts'

/** Header chip with the engine status; opens a popover with the tools and their problems. */
export function EngineStatus() {
  const health = useHealth()
  // Lives here, not in the popover, so a pending re-check survives closing and reopening it.
  const recheck = useRecheckHealth()
  const recheckControl: Recheck = {
    run: () => recheck.mutate(),
    pending: recheck.isPending,
    // A failed re-check stops mattering once a newer result arrives (e.g. the server came back).
    error: recheck.isError && recheck.submittedAt > health.dataUpdatedAt ? recheck.error : null,
  }
  const state = engineState(health)
  const summary = summarize(state)
  const text = statusText(summary)

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          if (!open && !recheck.isPending) recheck.reset()
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" aria-label={text} className="-mr-1.5" />}
        >
          <EngineStateIcon kind={state.kind} tone={summary.tone} />
          {/* Below sm the icon says it, and the folder beside it keeps the room; the button's
              name and the live region below still say it in words. */}
          <span className="max-sm:hidden">{summary.label}</span>
          {summary.detail !== undefined && (
            <span className="text-muted-foreground max-sm:hidden">· {summary.detail}</span>
          )}
          <ChevronDown aria-hidden className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-(--available-width) gap-3 p-3">
          <PopoverBody
            state={state}
            title={
              summary.detail === undefined ? summary.label : `${summary.label}, ${summary.detail}`
            }
            recheck={recheckControl}
            onRetry={() => health.refetch()}
          />
        </PopoverContent>
      </Popover>
      {/* Outside the button: a live region inside a button isn't reliably announced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {text}
      </span>
    </>
  )
}

type BodyProps = {
  state: EngineState
  title: string
  recheck: Recheck
  onRetry: () => Promise<unknown>
}

function PopoverBody({ state, title, recheck, onRetry }: BodyProps) {
  switch (state.kind) {
    case 'checking':
      return <CheckingMessage title={title} />
    case 'offline':
      return <OfflineMessage title={title} onRetry={onRetry} />
    case 'unexpected':
      return <UnexpectedMessage title={title} error={state.error} onRetry={onRetry} />
    default:
      return <EngineDetails state={state} title={title} recheck={recheck} />
  }
}
