import type { Collection } from '@dj-scraper/shared'
import { Info } from 'lucide-react'
import { memo } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { ListLinks } from './collection-lists.tsx'
import {
  kindLabel,
  listNoun,
  listsNote,
  skippedNote,
  totalDurationText,
  trackCountText,
  truncatedNote,
} from './collection-text.ts'
import type { TableRow } from './rows.ts'

type CollectionHeaderProps = {
  collection: Collection
  /** The enriched rows: the total duration grows as partial rows fill in. */
  rows: readonly TableRow[]
  titleId: string
  onOpenList: (url: string) => void
}

/**
 * Artwork, title, owner, kind and platform, then the counts ("50 of 214 tracks · ≈ 3 h 12 min")
 * and notes on what the table leaves out: a listing cap, rows that aren't tracks, linked lists.
 * Memoized, so selection changes don't re-render it.
 */
export const CollectionHeader = memo(function CollectionHeader({
  collection,
  rows,
  titleId,
  onOpenList,
}: CollectionHeaderProps) {
  const { lists } = collection
  const listsOnly = collection.entries.length === 0 && lists !== undefined
  const facts = [
    listsOnly ? listNoun(collection, lists.length) : trackCountText(collection),
    totalDurationText(collection, rows),
  ].filter((fact) => fact !== undefined)
  const notes = [truncatedNote(collection), skippedNote(collection)].filter(
    (note) => note !== undefined,
  )
  const linkedLists = listsOnly ? undefined : lists

  return (
    <div className="flex shrink-0 gap-4 px-4 pt-4 pb-3">
      <Artwork src={collection.thumbnailUrl} size={72} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2
          id={titleId}
          className="line-clamp-2 text-lg leading-snug font-semibold text-balance wrap-break-word"
          title={collection.title}
        >
          {collection.title}
        </h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {collection.owner !== undefined && (
            <span className="max-w-full truncate">{collection.owner}</span>
          )}
          <Badge variant="secondary">{kindLabel(collection)}</Badge>
          <PlatformBadge platform={collection.platform} />
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">{facts.join(' · ')}</p>
        {(notes.length > 0 || linkedLists !== undefined) && (
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
            {notes.map((note) => (
              <li key={note} className="flex items-start gap-1.5">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                {note}
              </li>
            ))}
            {linkedLists !== undefined && (
              <li className="flex items-start gap-1.5">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  {listsNote(collection)}
                  <ListLinks lists={linkedLists} onOpenList={onOpenList} />
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
})
