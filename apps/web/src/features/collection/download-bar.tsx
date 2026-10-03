import { type Collection, sanitizeFolderName } from '@dj-scraper/shared'
import { CircleCheck, Download, Folder } from 'lucide-react'
import { useId } from 'react'
import { FolderPath } from '@/components/folder-path.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { type TrackKey, toTrackRef } from '@/features/downloads/track-ref.ts'
import { useCreateDownloads } from '@/features/downloads/use-create-downloads.ts'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { FormatSelect } from '@/features/settings/format-select.tsx'
import { useSettings, useUpdateSettings } from '@/features/settings/use-settings.ts'
import { describeError } from '@/lib/error-text.ts'
import { downloadButtonText, queuedText } from './collection-text.ts'
import { selectedInOrder, type TableRow } from './rows.ts'

type DownloadBarProps = {
  collection: Collection
  /** Every row in table order (not just the filtered ones): the selection outlives the filter. */
  rows: readonly TableRow[]
  selected: ReadonlySet<TrackKey>
  /** How many tracks are selected (rows sharing a track count once). */
  count: number
}

/**
 * Where and how the selection downloads (the folder is changed in the header), and the button
 * that queues it: the selected rows in table order, with what enrichment filled in, labelled with
 * the list's title and, when the switch is on, into a subfolder named after it.
 */
export function DownloadBar({ collection, rows, selected, count }: DownloadBarProps) {
  const settings = useSettings()
  const updateSettings = useUpdateSettings()
  const create = useCreateDownloads()
  const formatId = useId()
  const current = settings.data
  // What the server will call the folder (it sanitizes the title the same way). A title of only
  // dots or characters no file system takes ("???") names none: the server would refuse it, so
  // such a list downloads into the folder itself, and the switch says so.
  const subfolder = sanitizeFolderName(collection.title)
  const intoSubfolder = (current?.playlistSubfolder ?? false) && subfolder !== undefined
  const subfolderLabel =
    subfolder === undefined
      ? "Into a subfolder (this list's title can't name one)"
      : `Into a subfolder: ${subfolder}`
  const failure = create.isError ? describeError(create.error) : undefined

  const download = () => {
    if (current === undefined) return
    const items = selectedInOrder(rows, selected).map((row) => toTrackRef(row.entry))
    if (items.length === 0) return
    create.mutate({
      items,
      label: collection.title,
      ...(current.playlistSubfolder && subfolder !== undefined
        ? { subfolder: collection.title }
        : {}),
    })
  }

  return (
    // Sticky only where the table scrolls in its own column: below lg the page scrolls, and a bar
    // stuck over the table's bottom would hide the row the keyboard focus moves to.
    <div
      data-slot="download-bar"
      className="shrink-0 border-t bg-background px-4 py-2.5 lg:sticky lg:bottom-0 lg:z-10"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Folder aria-hidden className="size-3.5 shrink-0" />
          {current !== undefined ? (
            <>
              <span className="sr-only">Saves to </span>
              <FolderPath
                path={current.folder}
                title={`${current.folder} (change it in the header)`}
                className="text-foreground"
              >
                {intoSubfolder && <span className="text-muted-foreground">/{subfolder}</span>}
              </FolderPath>
            </>
          ) : settings.isError ? (
            <span className="truncate">
              Folder unknown: {describeError(settings.error)?.message ?? 'no settings'}
            </span>
          ) : (
            <Skeleton className="h-3.5 w-36" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={formatId} className="text-xs font-normal text-muted-foreground">
            Format
          </Label>
          <FormatSelect id={formatId} />
        </div>
        <Label className="min-w-0 text-xs font-normal">
          <Switch
            size="sm"
            checked={current?.playlistSubfolder ?? false}
            disabled={current === undefined}
            onCheckedChange={(on) => updateSettings.mutate({ playlistSubfolder: on })}
          />
          <span className="truncate" title={subfolderLabel}>
            {subfolderLabel}
          </span>
        </Label>
        <Button
          className="ml-auto"
          // Stays focusable while queuing, so the keyboard focus isn't lost.
          focusableWhenDisabled
          disabled={count === 0 || current === undefined || create.isPending}
          onClick={download}
        >
          {create.isPending ? <Spinner aria-hidden /> : <Download aria-hidden />}
          {create.isPending ? 'Queuing…' : downloadButtonText(count)}
        </Button>
      </div>
      <div aria-live="polite" className="text-xs">
        {create.isSuccess && (
          <p className="mt-2 flex items-center gap-1.5 text-success">
            <CircleCheck aria-hidden className="size-3.5 shrink-0" />
            {queuedText(create.data)}
          </p>
        )}
        {failure !== undefined && (
          <div role="alert" className="mt-2 flex flex-col gap-0.5">
            <p className="text-destructive">
              <ProblemText message={failure.message} />
            </p>
            {failure.hint !== undefined && (
              <p className="text-muted-foreground">
                <ProblemText message={failure.hint} />
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
