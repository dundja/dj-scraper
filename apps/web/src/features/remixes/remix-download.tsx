import type { RemixUpload } from '@dj-scraper/shared'
import { ChevronDown, CircleAlert, Download } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { TrackJobStatus } from '@/features/collection/job-status.tsx'
import { describeError } from '@/lib/error-text.ts'
import { uploadText } from './remix-text.ts'
import { useRemixDownload } from './use-remix-download.ts'

type RemixDownloadProps = {
  /** Most played first: the first is the one Download takes. */
  uploads: readonly RemixUpload[]
  /** The job of the upload downloaded last, once the server has answered. */
  jobId: string | undefined
  onQueued: (upload: RemixUpload, jobId: string) => void
  /** The Download button's accessible name; "Download <title>" by default. */
  label?: string
  /** Leave out the room a missing upload menu keeps (that lines Download up down a list). */
  alone?: boolean
  /** Show the job's status beside the button (a row shows it under its title instead). */
  showStatus?: boolean
}

/**
 * A suggestion's download: Download takes its most played upload, and with more than one upload a
 * menu picks another. Once the server has answered, the job's status shows beside it (unless the
 * caller shows it elsewhere); a failure to add it shows below for a few seconds. Nothing downloads
 * by itself.
 */
export function RemixDownload({
  uploads,
  jobId,
  onQueued,
  label,
  alone = false,
  showStatus = true,
}: RemixDownloadProps) {
  const { download, pending, added, error } = useRemixDownload(onQueued)
  const top = uploads[0]
  if (top === undefined) return null
  const failure = error === null ? undefined : describeError(error)
  let progress = ''
  if (pending) progress = 'Adding to downloads…'
  // Only where it was pressed: the row and the bar both show the playing upload's Download.
  else if (added) progress = 'Added to downloads'

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {/* The job's chip on the button's line: a starting download doesn't grow the row. */}
      <div className="flex items-center gap-1">
        {showStatus && jobId !== undefined && (
          <span className="mr-1 max-w-24">
            <TrackJobStatus jobId={jobId} />
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-label={label ?? `Download ${top.title}`}
          disabled={pending}
          focusableWhenDisabled
          onClick={() => download(top)}
        >
          {pending ? <Spinner aria-hidden /> : <Download aria-hidden />}
          {/* The label goes on narrow screens, where the title needs the room; the aria-label stays. */}
          <span className="max-sm:hidden">Download</span>
        </Button>
        {uploads.length > 1 ? (
          <UploadMenu
            title={top.title}
            uploads={uploads}
            disabled={pending}
            onPick={(upload) => download(upload)}
          />
        ) : (
          // The menu's room, so the Download buttons line up down the list.
          !alone && <span aria-hidden className="size-7 shrink-0" />
        )}
      </div>
      <span role="status" className="sr-only">
        {progress}
      </span>
      {failure !== undefined && (
        <p role="alert" className="flex max-w-48 items-start gap-1 text-xs text-destructive">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{failure.message}</span>
        </p>
      )}
    </div>
  )
}

type UploadMenuProps = {
  /** The suggestion's default upload's title, for the trigger's name. */
  title: string
  uploads: readonly RemixUpload[]
  disabled: boolean
  onPick: (upload: RemixUpload) => void
}

/** "Choose upload": each upload of the version, by platform, uploader, plays and length. */
function UploadMenu({ title, uploads, disabled, onPick }: UploadMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button variant="outline" size="icon-sm" aria-label={`Choose upload of ${title}`} />
        }
      >
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Choose upload</DropdownMenuLabel>
          {uploads.map((upload) => (
            <DropdownMenuItem
              key={`${upload.platform}:${upload.id}`}
              className="flex-col items-start gap-0.5"
              onClick={() => onPick(upload)}
            >
              <span className="text-sm">{uploadText(upload)}</span>
              <span className="w-full truncate text-xs text-muted-foreground">{upload.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
