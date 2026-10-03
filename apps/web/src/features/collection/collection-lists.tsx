import type { CollectionLink } from '@dj-scraper/shared'
import { ChevronRight, ListMusic } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { listTitle } from './collection-text.ts'

// Lists a page links to instead of tracks (the sets on a SoundCloud profile): each opens by
// resolving its URL.

/** How many links show inline in the header before they fold into a disclosure. */
const INLINE_LINKS = 3

type ListsProps = {
  lists: readonly CollectionLink[]
  onOpenList: (url: string) => void
}

/** The header note's links, beside a page's tracks: inline when few, folded when many. */
export function ListLinks({ lists, onOpenList }: ListsProps) {
  const links = lists.map((list) => (
    <li key={list.url}>
      <Button
        variant="link"
        size="xs"
        className="h-auto px-0 text-xs"
        aria-label={`Open ${listTitle(list)}`}
        onClick={() => onOpenList(list.url)}
      >
        {listTitle(list)}
      </Button>
    </li>
  ))
  if (lists.length <= INLINE_LINKS) {
    return <ul className="flex flex-wrap gap-x-3 gap-y-0.5">{links}</ul>
  }
  return (
    <details className="group">
      <summary className="w-fit cursor-pointer rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        Show them
      </summary>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{links}</ul>
    </details>
  )
}

/** A page with lists but no tracks (a SoundCloud Sets tab): the lists are what there is to open. */
export function ListsContent({ lists, onOpenList }: ListsProps) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <p className="text-sm text-muted-foreground">
        This page lists no tracks of its own. Open one of its lists to pick tracks from it.
      </p>
      <ul aria-label="Lists on this page" className="divide-y overflow-hidden rounded-lg border">
        {lists.map((list) => (
          <li key={list.url}>
            <button
              type="button"
              aria-label={`Open ${listTitle(list)}`}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => onOpenList(list.url)}
            >
              <ListMusic aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{listTitle(list)}</span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
