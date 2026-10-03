import type { JobScope } from '@dj-scraper/shared'
import { CircleX, Ellipsis, ListX, RotateCcw } from 'lucide-react'
import { type Ref, useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { BULK_ACTIONS, type BulkRequest } from './panel-actions.ts'
import type { JobsSummary } from './summary.ts'

type Props = {
  /** The trigger's accessible name, e.g. "Download actions" or "Actions for Summer 2026". */
  label: string
  target: JobScope
  /** The jobs in `target`: an action with nothing to act on is disabled. */
  summary: JobsSummary
  onAction: (request: BulkRequest) => void
  /**
   * Where the focus goes instead of the trigger after "Clear finished" on a target whose jobs have
   * all finished: the clear removes them, and this menu with them. Gets how many jobs go.
   */
  focusAfterClear: (cleared: number) => HTMLElement | null
  triggerRef?: Ref<HTMLButtonElement>
}

/** The "⋯" menu of bulk actions over every job or one batch. */
export function BulkMenu({ label, target, summary, onAction, focusAfterClear, triggerRef }: Props) {
  // Whether the chosen action removes this menu: then the focus can't go back to its trigger.
  const removesMenu = useRef(false)
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) removesMenu.current = false
      }}
    >
      <DropdownMenuTrigger
        ref={triggerRef}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground"
          />
        }
      >
        <Ellipsis aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44"
        finalFocus={() => (removesMenu.current && focusAfterClear(summary.total)) || true}
      >
        <DropdownMenuItem
          disabled={summary.retryableFailed === 0}
          onClick={() => onAction({ action: 'retry', target })}
        >
          <RotateCcw aria-hidden />
          {BULK_ACTIONS.retry.label}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={summary.finished === 0}
          onClick={() => {
            removesMenu.current = summary.finished === summary.total
            onAction({ action: 'clear', target })
          }}
        >
          <ListX aria-hidden />
          {BULK_ACTIONS.clear.label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={summary.active === 0}
          onClick={() => onAction({ action: 'cancel', target })}
        >
          <CircleX aria-hidden />
          {BULK_ACTIONS.cancel.label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
