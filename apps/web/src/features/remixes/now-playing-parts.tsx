import type { RemixUpload } from '@dj-scraper/shared'
import { CircleAlert, Gauge, Pause, Play, RotateCw } from 'lucide-react'
import { type Ref, useMemo } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { describeError } from '@/lib/error-text.ts'
import { rangeFill } from '@/lib/range.ts'
import { cn } from '@/lib/utils.ts'
import {
  type NowPlaying,
  type PreviewState,
  seekPreview,
  setPreviewPitchLock,
  setPreviewRate,
} from './preview-player.ts'
import { formatClockTime, formatRate, positionText } from './preview-rate.ts'
import { RemixDownload } from './remix-download.tsx'
import { useRemixJobId } from './remix-jobs.ts'
import { RemixSpeed } from './remix-speed.tsx'
import { REMIX_PLATFORM_DOTS, REMIX_PLATFORM_NAMES } from './remix-text.ts'

/**
 * Cover, what tells the version apart (its row's title; the whole title in the tooltip), and
 * "Remix by X · ● YouTube": what is playing, and from where.
 */
export function NowPlayingInfo({ nowPlaying }: { nowPlaying: NowPlaying }) {
  const { upload, credit, version } = nowPlaying
  const platform = REMIX_PLATFORM_NAMES[upload.platform]
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Artwork src={upload.thumbnailUrl} size={48} sizeClassName="size-10 lg:size-12" />
      <div className="min-w-0">
        <p title={upload.title} className="truncate text-sm font-semibold">
          {version ?? upload.title}
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {credit !== undefined && credit !== '' && (
            // On a phone the platform alone: the credit is in the row.
            <>
              <span className="truncate max-sm:hidden">{credit}</span>
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
            </>
          )}
          <span
            className="flex min-w-0 items-center gap-1.5"
            title={`The upload's own ${platform} stream, not the file a download makes`}
          >
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full', REMIX_PLATFORM_DOTS[upload.platform])}
            />
            <span className="truncate">{platform}</span>
          </span>
        </p>
      </div>
    </div>
  )
}

type PlayPauseProps = {
  status: PreviewState['status']
  onToggle: () => void
  ref?: Ref<HTMLButtonElement>
}

/**
 * The round violet play/pause; while the audio is prepared, a spinner that cancels on click. After
 * a failure it stays, disabled but focusable, so the focus it had isn't lost (Try again plays).
 */
export function PlayPauseButton({ status, onToggle, ref }: PlayPauseProps) {
  let label = 'Play'
  let icon = <Play aria-hidden className="fill-current" />
  if (status === 'playing') {
    label = 'Pause'
    icon = <Pause aria-hidden className="fill-current" />
  } else if (status === 'preparing') {
    label = 'Cancel preparing'
    icon = <Spinner aria-hidden className="size-5 motion-reduce:animate-none" />
  }
  return (
    <Button
      ref={ref}
      size="icon-lg"
      aria-label={label}
      title={status === 'preparing' ? 'Preparing audio… Click to cancel' : undefined}
      disabled={status === 'error'}
      focusableWhenDisabled
      className="size-10 rounded-full aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4.5"
      onClick={onToggle}
    >
      {icon}
    </Button>
  )
}

type SeekProps = { state: PreviewState; durationSec: number | undefined }

/** Elapsed time, the seek bar and the length, in mono so they hold still while they change. */
export function SeekBar({ state, durationSec }: SeekProps) {
  const duration = state.duration ?? durationSec
  const max = duration ?? Math.max(state.currentTime, 1)
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">
        {formatClockTime(state.currentTime)}
      </span>
      <input
        type="range"
        aria-label="Seek"
        aria-valuetext={positionText(state.currentTime, duration)}
        min={0}
        max={max}
        step={1}
        value={state.currentTime}
        disabled={duration === undefined}
        onChange={(event) => seekPreview(event.currentTarget.valueAsNumber)}
        style={rangeFill(state.currentTime, 0, max)}
        className="range-input h-4 min-w-0 flex-1"
      />
      <span className="w-10 shrink-0 font-mono tabular-nums">
        {duration === undefined ? '–:––' : formatClockTime(duration)}
      </span>
    </div>
  )
}

/** Why the audio couldn't be prepared or played, with a next step, and Try again. */
export function PlayerError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const failure = describeError(error)
  return (
    <div role="alert" className="flex min-w-0 items-center gap-x-3 gap-y-1 text-xs">
      <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
      <p className="line-clamp-2 min-w-0 flex-1">
        <span className="text-destructive">
          {failure?.message ?? "This audio can't be played."}
        </span>
        {failure?.hint !== undefined && (
          <span className="text-muted-foreground">
            {' '}
            <ProblemText message={failure.hint} />
          </span>
        )}
      </p>
      <Button variant="outline" size="xs" className="shrink-0" onClick={onRetry}>
        <RotateCw aria-hidden />
        Try again
      </Button>
    </div>
  )
}

type SpeedProps = Pick<PreviewState, 'rate' | 'preservesPitch'>

/** The speed grid in one row, for a window wide enough to hold it beside the seek bar. */
export function InlineSpeed({ rate, preservesPitch }: SpeedProps) {
  return (
    <RemixSpeed
      layout="inline"
      rate={rate}
      preservesPitch={preservesPitch}
      onRate={setPreviewRate}
      onPitchLock={setPreviewPitchLock}
    />
  )
}

/** The speed as a button showing it ("1.10x") that opens the whole speed grid, with its slider. */
export function SpeedPopover({ rate, preservesPitch }: SpeedProps) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label={`Playback speed, ${formatRate(rate)}`} />
        }
      >
        <Gauge aria-hidden className="max-sm:hidden" />
        <span className="font-mono tabular-nums">{formatRate(rate)}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[23rem] max-w-(--available-width) p-3">
        <RemixSpeed
          layout="stacked"
          rate={rate}
          preservesPitch={preservesPitch}
          onRate={setPreviewRate}
          onPitchLock={setPreviewPitchLock}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Download for the upload that plays: the same as its row's (one upload, never by itself), and
 * its job goes to the row's section, so the row shows it too. The job's chip shows here as well.
 */
export function NowPlayingDownload({ nowPlaying }: { nowPlaying: NowPlaying }) {
  const { upload, jobs } = nowPlaying
  const uploads = useMemo<readonly RemixUpload[]>(() => [upload], [upload])
  const jobId = useRemixJobId(jobs, uploads)
  return (
    <RemixDownload
      uploads={uploads}
      jobId={jobId}
      onQueued={jobs.remember}
      label="Download playing remix"
      alone
    />
  )
}
