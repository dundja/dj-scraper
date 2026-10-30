import {
  PREVIEW_RATE_MAX,
  PREVIEW_RATE_MIN,
  PREVIEW_RATE_PRESETS,
  PREVIEW_RATE_STEP,
} from '@dj-scraper/shared'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { rangeFill } from '@/lib/range.ts'
import { cn } from '@/lib/utils.ts'
import { formatRate, isPresetRate, nudgeRate, presetLabel } from './preview-rate.ts'

type RemixSpeedProps = {
  rate: number
  preservesPitch: boolean
  onRate: (rate: number) => void
  onPitchLock: (on: boolean) => void
  /**
   * `inline`: one row for the now-playing bar on a wide window (presets, −, the value, +, Reset,
   * Keep pitch). `stacked`: rows for the speed popover, with the fine slider as well.
   */
  layout: 'inline' | 'stacked'
}

/**
 * A DJ's pitch control for the preview: preset speeds, nudge buttons (0.01 each) around the exact
 * value, a fine slider (stacked), a reset to 1x and the pitch lock ("Keep pitch": the key stays
 * while the speed changes). The speed only changes what you hear; a download is never changed by it.
 */
export function RemixSpeed({ rate, preservesPitch, onRate, onPitchLock, layout }: RemixSpeedProps) {
  const lockId = useId()
  const inline = layout === 'inline'
  const presets = (
    <div className="flex flex-wrap items-center gap-1">
      {PREVIEW_RATE_PRESETS.map((preset) => {
        const pressed = isPresetRate(rate, preset)
        return (
          <Button
            key={preset}
            variant={pressed ? 'default' : 'outline'}
            size="xs"
            aria-pressed={pressed}
            className="font-mono tabular-nums"
            onClick={() => onRate(preset)}
          >
            {presetLabel(preset)}
          </Button>
        )
      })}
    </div>
  )
  const slower = (
    <Button
      variant="outline"
      size="icon-xs"
      aria-label="Slower by 0.01x"
      disabled={rate <= PREVIEW_RATE_MIN}
      onClick={() => onRate(nudgeRate(rate, -1))}
    >
      <Minus aria-hidden />
    </Button>
  )
  const faster = (
    <Button
      variant="outline"
      size="icon-xs"
      aria-label="Faster by 0.01x"
      disabled={rate >= PREVIEW_RATE_MAX}
      onClick={() => onRate(nudgeRate(rate, 1))}
    >
      <Plus aria-hidden />
    </Button>
  )
  const value = (
    <output
      aria-label="Current speed"
      className={cn(
        'font-mono text-sm tabular-nums',
        inline ? 'w-12 text-center' : 'w-12 text-right',
      )}
    >
      {formatRate(rate)}
    </output>
  )
  const reset = (
    <Button
      variant="ghost"
      size={inline ? 'icon-xs' : 'xs'}
      aria-label={inline ? 'Reset to 1x' : undefined}
      title={inline ? 'Reset to 1x' : undefined}
      onClick={() => onRate(1)}
      disabled={isPresetRate(rate, 1)}
    >
      <RotateCcw aria-hidden />
      {!inline && 'Reset to 1x'}
    </Button>
  )
  const lock = (
    <label htmlFor={lockId} className="flex shrink-0 items-center gap-1.5 text-xs">
      <Switch id={lockId} size="sm" checked={preservesPitch} onCheckedChange={onPitchLock} />
      Keep pitch
    </label>
  )

  if (inline) {
    return (
      <fieldset className="flex min-w-0 items-center gap-1.5">
        <legend className="sr-only">Playback speed</legend>
        {presets}
        <Divider />
        {slower}
        {value}
        {faster}
        {reset}
        <Divider />
        {lock}
      </fieldset>
    )
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="sr-only">Playback speed</legend>
      {presets}
      <div className="flex items-center gap-2">
        {slower}
        <input
          type="range"
          aria-label="Speed"
          aria-valuetext={formatRate(rate)}
          min={PREVIEW_RATE_MIN}
          max={PREVIEW_RATE_MAX}
          step={PREVIEW_RATE_STEP}
          value={rate}
          onChange={(event) => onRate(event.currentTarget.valueAsNumber)}
          style={rangeFill(rate, PREVIEW_RATE_MIN, PREVIEW_RATE_MAX)}
          className="range-input h-4 min-w-24 flex-1"
        />
        {faster}
        {value}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {reset}
        {lock}
      </div>
    </fieldset>
  )
}

/** A hairline between the speed grid's groups. */
function Divider() {
  return <span aria-hidden className="mx-1.5 h-6 w-px shrink-0 bg-border" />
}
