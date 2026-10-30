import type { Track } from '@dj-scraper/shared'
import { ChevronRight } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { releasePreview } from './preview-player.ts'
import { createRemixJobs } from './remix-jobs.ts'
import { RemixResults } from './remix-results.tsx'
import { RemixError, RemixSkeleton } from './remix-states.tsx'
import { remixCount, searchedText } from './remix-text.ts'
import { useRemixes } from './use-remixes.ts'

/**
 * Remix suggestions under a single track's card (ADR-027): its song's remixes on YouTube and
 * SoundCloud, most played first, each downloadable on its own. Collapsible, open by default; the
 * searches run beside the card's own download and never hold it up: YouTube's rows show first,
 * SoundCloud's join them when its slower search is in (`useRemixes`). The panel stays mounted when
 * closed, and the rows' jobs are kept above the rows (`createRemixJobs`), so their status survives
 * closing the panel, filtering and the full answer replacing the quick one; the now-playing bar
 * records its downloads there too. A remix played from here plays on in the bar until the section
 * leaves (a new paste), which stops it.
 */
export function RemixSection({ track }: { track: Track }) {
  const { view, retry, retrying } = useRemixes(track)
  const [jobs] = useState(createRemixJobs)
  useEffect(() => () => releasePreview(jobs), [jobs])
  const headingId = useId()
  const ready = view.status === 'ready' ? view : undefined
  const count = ready?.remixes.suggestions.length

  return (
    <section aria-labelledby={headingId} data-slot="remix-section" className="@container">
      <Collapsible defaultOpen className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            <CollapsibleTrigger className="group/trigger -mx-1 flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                aria-hidden
                className="size-4 text-muted-foreground group-data-[panel-open]/trigger:rotate-90 motion-safe:transition-transform"
              />
              Remixes{' '}
              {count !== undefined && (
                <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
              )}
            </CollapsibleTrigger>
          </h2>
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            {view.status === 'pending' && (
              <>
                <Spinner aria-hidden className="size-3" />
                Searching YouTube and SoundCloud for remixes…
              </>
            )}
            {ready !== undefined && (
              <span>
                <span className="sr-only">
                  {remixCount(ready.remixes.suggestions.length)} found.{' '}
                </span>
                {searchedText(ready.remixes.song)}
              </span>
            )}
          </p>
        </div>
        <CollapsibleContent keepMounted>
          {view.status === 'pending' && <RemixSkeleton />}
          {view.status === 'error' && (
            <RemixError error={view.error} retrying={retrying} onRetry={retry} />
          )}
          {ready !== undefined && (
            <RemixResults
              remixes={ready.remixes}
              searching={ready.searching}
              jobs={jobs}
              retrying={retrying}
              onRetry={retry}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
