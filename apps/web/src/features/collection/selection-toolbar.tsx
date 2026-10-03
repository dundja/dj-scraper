import { Search, X } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group.tsx'
import { formatCount, selectionCountText, selectionText } from './collection-text.ts'
import type { SelectionSummary } from './rows.ts'

type SelectionToolbarProps = {
  summary: SelectionSummary
  query: string
  onQueryChange: (query: string) => void
  /** Rows the filter shows, of `total`. */
  shown: number
  total: number
  /** All / none / invert over the rows the filter shows. */
  onSelect: (change: 'all' | 'none' | 'invert') => void
}

/**
 * Select all / none / invert, the filter, and the count and length of the selection. The buttons
 * act on the rows the filter shows; the filter itself never changes the selection. Only the count
 * is announced: the length changes as partial rows fill in, which nobody asked to hear.
 */
export function SelectionToolbar({
  summary,
  query,
  onQueryChange,
  shown,
  total,
  onSelect,
}: SelectionToolbarProps) {
  const filterRef = useRef<HTMLInputElement>(null)
  const filtering = query.trim() !== ''
  const scope = filtering ? 'Acts on the rows the filter shows' : undefined

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-3">
      <div className="flex items-center gap-1">
        <span aria-hidden className="mr-1 text-xs text-muted-foreground">
          Select
        </span>
        <Button
          variant="outline"
          size="xs"
          aria-label="Select all"
          title={scope}
          onClick={() => onSelect('all')}
        >
          All
        </Button>
        <Button
          variant="outline"
          size="xs"
          aria-label="Select none"
          title={scope}
          onClick={() => onSelect('none')}
        >
          None
        </Button>
        <Button
          variant="outline"
          size="xs"
          aria-label="Invert selection"
          title={scope}
          onClick={() => onSelect('invert')}
        >
          Invert
        </Button>
      </div>
      <InputGroup className="h-7 w-full sm:w-64">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={filterRef}
          aria-label="Filter tracks"
          placeholder="Filter by title or artist"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault()
              event.stopPropagation()
              onQueryChange('')
            }
          }}
        />
        {query !== '' && (
          <InputGroupAddon align="inline-end">
            {filtering && (
              <span className="text-xs font-normal tabular-nums">
                {formatCount(shown)} of {formatCount(total)}
              </span>
            )}
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear filter"
              onClick={() => {
                onQueryChange('')
                // The button goes away with the query: keep focus in the filter.
                filterRef.current?.focus()
              }}
            >
              <X aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <p
        data-slot="selection-summary"
        className="text-xs text-muted-foreground tabular-nums sm:ml-auto"
      >
        {selectionText(summary)}
      </p>
      <p role="status" className="sr-only">
        {selectionCountText(summary.count)}
      </p>
    </div>
  )
}
