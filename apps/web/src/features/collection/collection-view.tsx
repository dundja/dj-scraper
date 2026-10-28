import type { Collection } from '@dj-scraper/shared'
import { ListX } from 'lucide-react'
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx'
import { useDownloadedTrackKeys } from '@/features/downloads/use-downloads.ts'
import { CollectionHeader } from './collection-header.tsx'
import { ListsContent } from './collection-lists.tsx'
import { skippedNote, tableEmptyText } from './collection-text.ts'
import { DownloadBar } from './download-bar.tsx'
import { instanceKey } from './instance-key.ts'
import { countRowsOf, filterRows, summarize, tableRows, withoutRowsOf } from './rows.ts'
import { SelectionToolbar } from './selection-toolbar.tsx'
import { TrackTable } from './track-table.tsx'
import { useEnrichment } from './use-enrichment.ts'
import { useSelection } from './use-selection.ts'

type CollectionViewProps = {
  collection: Collection
  /** Resolves a list the page links to (a set on a SoundCloud profile). */
  onOpenList: (url: string) => void
}

/** A resolved list: header, track table with selection, and the download bar. */
export function CollectionView({ collection, onOpenList }: CollectionViewProps) {
  // Another collection starts over (enrichment, selection, filter), even when the parent keeps
  // this view mounted, e.g. after opening one of the lists a page links to.
  return (
    <CollectionPage key={instanceKey(collection)} collection={collection} onOpenList={onOpenList} />
  )
}

function CollectionPage({ collection, onOpenList }: CollectionViewProps) {
  const titleId = useId()
  const enrichment = useEnrichment(collection.entries)
  const rows = useMemo(() => tableRows(enrichment.rows), [enrichment.rows])
  // The selection covers every row, also those "Hide downloaded" takes out: turning it off brings
  // their checks back.
  const [selection, dispatch] = useSelection(rows)
  const [query, setQuery] = useState('')
  const [hideDownloaded, setHideDownloaded] = useState(false)
  // The same array until a track's newest job ends downloaded or another job replaces it, so a
  // progress event changes nothing here.
  const downloadedKeys = useDownloadedTrackKeys()
  const downloaded = useMemo(() => new Set(downloadedKeys), [downloadedKeys])
  const downloadedRows = useMemo(() => countRowsOf(rows, downloaded), [rows, downloaded])
  // The rows the table, the selection line and the download work on: all, or the ones not
  // downloaded yet. A row that finishes while the toggle is on leaves by itself.
  const kept = useMemo(
    () => (hideDownloaded ? withoutRowsOf(rows, downloaded) : rows),
    [hideDownloaded, rows, downloaded],
  )
  const shown = useMemo(() => filterRows(kept, query), [kept, query])
  const summary = useMemo(() => summarize(kept, selection.selected), [kept, selection.selected])
  // Read at click time (after the commit), so the callback stays the same while rows fill in and a
  // memoized row re-renders only when it changed.
  const shownRef = useRef(shown)
  useLayoutEffect(() => {
    shownRef.current = shown
  })
  const onRowClick = useCallback(
    (position: number, shift: boolean) =>
      dispatch({ type: 'click', rows: shownRef.current, position, shift }),
    [dispatch],
  )

  const header = (
    <CollectionHeader
      collection={collection}
      rows={rows}
      titleId={titleId}
      onOpenList={onOpenList}
    />
  )
  if (rows.length === 0) {
    return (
      <section aria-labelledby={titleId} className="flex flex-col">
        {header}
        {collection.lists !== undefined ? (
          <ListsContent lists={collection.lists} onOpenList={onOpenList} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListX aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No tracks here</EmptyTitle>
              <EmptyDescription>
                {/* The header already says when rows aren't tracks. */}
                {skippedNote(collection) === undefined && 'This list is empty. '}Try another link.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby={titleId} className="@container flex min-h-0 flex-1 flex-col">
      {header}
      <SelectionToolbar
        summary={summary}
        query={query}
        onQueryChange={setQuery}
        shown={shown.length}
        total={kept.length}
        onSelect={(change) => dispatch({ type: change, rows: shown })}
        downloaded={downloadedRows}
        hideDownloaded={hideDownloaded}
        onHideDownloadedChange={setHideDownloaded}
      />
      <TrackTable
        rows={shown}
        selected={selection.selected}
        onRowClick={onRowClick}
        onRowsInViewChange={enrichment.setRowsInView}
        empty={tableEmptyText(query, hideDownloaded)}
      />
      <DownloadBar
        collection={collection}
        rows={kept}
        selected={selection.selected}
        count={summary.count}
      />
    </section>
  )
}
