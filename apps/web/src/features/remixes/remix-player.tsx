import type { RemixUpload } from '@dj-scraper/shared'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { describeError } from '@/lib/error-text.ts'
import type { PreviewState } from './preview-player.ts'
import { formatClockTime, positionText } from './preview-rate.ts'
import { RemixSpeed } from './remix-speed.tsx'
import { REMIX_PLATFORM_NAMES } from './remix-text.ts'

type RemixPlayerProps = {
  upload: RemixUpload
  state: PreviewState
  onToggle: () => void
  onSeek: (seconds: number) => void
  onRate: (rate: number) => void
  onPitchLock: (on: boolean) => void
}

/**
 * The strip under a row that is preparing, playing, paused or failed. It says what is heard: the
 * upload's own stream on its platform, not the file a download would write, and claims no quality.
 */
export function RemixPlayer({
  upload,
  state,
  onToggle,
  onSeek,
  onRate,
  onPitchLock,
}: RemixPlayerProps) {
  const { status } = state
  if (status === 'idle') return null
  const source = `Preview: ${REMIX_PLATFORM_NAMES[upload.platform]} stream`
  const failure = status === 'error' ? describeError(state.error) : undefined
  const duration = state.duration ?? upload.durationSec
  const message = {
    preparing: 'Preparing audio…',
    playing: `Playing. ${source}`,
    paused: `Paused. ${source}`,
    error: '',
  }[status]

  return (
    <section
      aria-label={`Preview of ${upload.title}`}
      className="flex flex-col gap-2 rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground"
    >
      <p role="status" className="flex items-center gap-2">
        {status === 'preparing' && (
          <Spinner aria-hidden className="size-3.5 motion-reduce:animate-none" />
        )}
        <span>{message}</span>
      </p>
      {failure !== undefined && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-destructive">
            {failure.message}
            {failure.hint !== undefined && (
              <span className="text-muted-foreground"> {failure.hint}</span>
            )}
          </p>
          <Button variant="outline" size="xs" onClick={onToggle}>
            Try again
          </Button>
        </div>
      )}
      {(status === 'playing' || status === 'paused') && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-10 text-right font-mono tabular-nums">
              {formatClockTime(state.currentTime)}
            </span>
            <input
              type="range"
              aria-label="Seek"
              aria-valuetext={positionText(state.currentTime, duration)}
              min={0}
              max={duration ?? Math.max(state.currentTime, 1)}
              step={1}
              value={state.currentTime}
              disabled={duration === undefined}
              onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
              className="h-4 min-w-24 flex-1 accent-primary"
            />
            <span className="w-10 font-mono tabular-nums">
              {duration === undefined ? '–:––' : formatClockTime(duration)}
            </span>
          </div>
          <RemixSpeed
            rate={state.rate}
            preservesPitch={state.preservesPitch}
            onRate={onRate}
            onPitchLock={onPitchLock}
          />
        </>
      )}
    </section>
  )
}
