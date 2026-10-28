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
import { formatRate, isPresetRate, nudgeRate, presetLabel } from './preview-rate.ts'

type RemixSpeedProps = {
  rate: number
  preservesPitch: boolean
  onRate: (rate: number) => void
  onPitchLock: (on: boolean) => void
}

/**
 * A DJ's pitch control for the preview: preset speeds, a fine slider with the exact value, nudge
 * buttons (0.01 each), a reset to 1x and the pitch lock ("Keep pitch": the key stays while the
 * speed changes). The speed only changes what you hear; a download is never changed by it.
 */
export function RemixSpeed({ rate, preservesPitch, onRate, onPitchLock }: RemixSpeedProps) {
  const lockId = useId()
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="sr-only">Playback speed</legend>
      <div className="flex flex-wrap items-center gap-1">
        {PREVIEW_RATE_PRESETS.map((preset) => {
          const pressed = isPresetRate(rate, preset)
          return (
            <Button
              key={preset}
              variant={pressed ? 'secondary' : 'outline'}
              size="xs"
              aria-pressed={pressed}
              className="tabular-nums"
              onClick={() => onRate(preset)}
            >
              {presetLabel(preset)}
            </Button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Slower by 0.01x"
          disabled={rate <= PREVIEW_RATE_MIN}
          onClick={() => onRate(nudgeRate(rate, -1))}
        >
          <Minus aria-hidden />
        </Button>
        <input
          type="range"
          aria-label="Speed"
          aria-valuetext={formatRate(rate)}
          min={PREVIEW_RATE_MIN}
          max={PREVIEW_RATE_MAX}
          step={PREVIEW_RATE_STEP}
          value={rate}
          onChange={(event) => onRate(event.currentTarget.valueAsNumber)}
          className="h-4 min-w-24 flex-1 accent-primary"
        />
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Faster by 0.01x"
          disabled={rate >= PREVIEW_RATE_MAX}
          onClick={() => onRate(nudgeRate(rate, 1))}
        >
          <Plus aria-hidden />
        </Button>
        <output aria-label="Current speed" className="w-12 text-right text-sm tabular-nums">
          {formatRate(rate)}
        </output>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onRate(1)}
          disabled={isPresetRate(rate, 1)}
        >
          <RotateCcw aria-hidden />
          Reset to 1x
        </Button>
        <label htmlFor={lockId} className="flex items-center gap-1.5 text-xs">
          <Switch id={lockId} size="sm" checked={preservesPitch} onCheckedChange={onPitchLock} />
          Keep pitch
        </label>
      </div>
    </fieldset>
  )
}
