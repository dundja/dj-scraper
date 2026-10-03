// Test doubles for the result views other packages own (TrackCard, CollectionView). The resolve
// tests swap them in with vi.mock, so they check what the page hands those views (props, one mount
// per paste) without depending on how the views render or what they fetch. The views have their
// own tests; e2e covers them together.
import type { Collection, Track } from '@dj-scraper/shared'
import { useEffect, useRef } from 'react'
import { type ViewMount, viewMounts } from './result-view-log.ts'

/**
 * Logs `mount` once per mount of the calling component, and again when it changes. The ref
 * survives StrictMode's simulated unmount and remount (which re-runs effects on the same
 * instance), so only a real remount, which starts a new ref, logs twice.
 */
function useLogMount(mount: ViewMount) {
  const logged = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = JSON.stringify(mount)
    if (logged.current === key) return
    logged.current = key
    viewMounts.push(mount)
  })
}

export function TrackCard({ track, autoStart }: { track: Track; autoStart: boolean }) {
  useLogMount({ view: 'track', id: track.id, autoStart })
  return (
    <article aria-label={`Track card: ${track.title}`} data-auto-start={String(autoStart)}>
      {track.title}
    </article>
  )
}

export function CollectionView({
  collection,
  onOpenList,
}: {
  collection: Collection
  onOpenList: (url: string) => void
}) {
  useLogMount({ view: 'collection', id: collection.id })
  return (
    <section aria-label={`Collection: ${collection.title}`}>
      {collection.lists?.map((list) => (
        <button key={list.url} type="button" onClick={() => onOpenList(list.url)}>
          {list.title ?? list.url}
        </button>
      ))}
    </section>
  )
}
