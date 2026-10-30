import type { RemixPlatform, RemixSuggestions } from '@dj-scraper/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
import type { RemixJobsStore } from './remix-jobs.ts'
import { REMIX_GRID, REMIX_ROW, WIDE_ONLY } from './remix-layout.ts'
import { RemixNotes } from './remix-notes.tsx'
import { RemixRow } from './remix-row.tsx'
import {
  emptyText,
  type GenreCount,
  genreCounts,
  searchFailures,
  suggestionKey,
} from './remix-text.ts'

type RemixResultsProps = {
  remixes: RemixSuggestions
  /** Platforms whose search is still running (the quick answer skipped them). */
  searching: readonly RemixPlatform[]
  /** The jobs the section's downloads (and the now-playing bar's) made, by upload. */
  jobs: RemixJobsStore
  /** A failed platform's search is running again. */
  retrying: boolean
  onRetry: () => void
}

/**
 * An answer: the notes (a platform still being searched, or whose search failed, with Try again),
 * the genre filter when the suggestions name two genres or more, then the column header and a row
 * per suggestion (at most 20, so no virtualization) or why there is none. The filter is local; a
 * genre a new answer lacks counts as All.
 */
export function RemixResults(props: RemixResultsProps) {
  const { remixes, searching, jobs, retrying, onRetry } = props
  const [genre, setGenre] = useState<string | null>(null)
  const { suggestions, searches } = remixes
  const genres = genreCounts(suggestions)
  const filtering = genres.length >= 2
  const active = filtering && genres.some(({ name }) => name === genre) ? genre : null
  const shown =
    active === null ? suggestions : suggestions.filter((item) => item.genre?.name === active)
  const empty = suggestions.length === 0 ? emptyText(searches) : undefined

  return (
    <div className="flex flex-col gap-3">
      <RemixNotes
        searching={searching}
        failures={searchFailures(searches)}
        retrying={retrying}
        onRetry={onRetry}
      />
      {filtering && (
        <GenreFilter
          genres={genres}
          total={suggestions.length}
          active={active}
          onChange={setGenre}
        />
      )}
      {shown.length > 0 && (
        <div className={REMIX_GRID}>
          <ColumnHeader />
          <ul aria-label="Remixes" className="col-span-full grid grid-cols-subgrid">
            {shown.map((suggestion) => (
              <RemixRow
                key={suggestionKey(suggestion)}
                suggestion={suggestion}
                song={remixes.song}
                jobs={jobs}
              />
            ))}
          </ul>
        </div>
      )}
      {empty !== undefined && <p className="text-sm text-muted-foreground">{empty}</p>}
    </div>
  )
}

/**
 * The columns' names over the rows, once the row is wide enough to have columns. Hidden from
 * assistive tech: the list stays a list, and each row's parts say what they are.
 */
function ColumnHeader() {
  return (
    <div
      aria-hidden
      data-slot="remix-columns"
      className={cn(
        REMIX_ROW,
        'hidden h-7 border-b text-xs text-muted-foreground @4xl:grid [&>span]:truncate',
      )}
    >
      <span />
      <span>Title</span>
      <span className={WIDE_ONLY}>Genre</span>
      <span className={WIDE_ONLY}>Platform</span>
      <span className={cn(WIDE_ONLY, 'text-right')}>Length</span>
      <span />
      <span />
    </div>
  )
}

type GenreFilterProps = {
  genres: GenreCount[]
  total: number
  /** The genre shown, or null for All. */
  active: string | null
  onChange: (genre: string | null) => void
}

/** All, then each genre with how many suggestions name it: toggle buttons, one pressed. */
function GenreFilter({ genres, total, active, onChange }: GenreFilterProps) {
  const chips: { name: string | null; label: string; count: number }[] = [
    { name: null, label: 'All', count: total },
    ...genres.map(({ name, count }) => ({ name, label: name, count })),
  ]
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-1.5">
      <legend className="sr-only">Filter remixes by genre</legend>
      {chips.map(({ name, label, count }) => {
        const pressed = name === active
        return (
          <Button
            key={name ?? ''}
            variant={pressed ? 'default' : 'outline'}
            size="xs"
            aria-pressed={pressed}
            className="rounded-full"
            onClick={() => onChange(name)}
          >
            {label}{' '}
            <span className={cn('tabular-nums', pressed ? 'opacity-70' : 'text-muted-foreground')}>
              {count}
            </span>
          </Button>
        )
      })}
    </fieldset>
  )
}
