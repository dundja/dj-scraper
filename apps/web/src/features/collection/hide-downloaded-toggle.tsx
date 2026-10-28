import { EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { formatCount } from './collection-text.ts'

type HideDownloadedToggleProps = {
  /** Rows whose track's newest job is done or already in the folder. */
  downloaded: number
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
}

/**
 * "Hide downloaded (12)": takes the rows already downloaded ("Done", "In folder") out of the table,
 * the selection line and the download, keeping their checks for when it's turned off. Not shown
 * while it's off and nothing here is downloaded.
 */
export function HideDownloadedToggle({
  downloaded,
  pressed,
  onPressedChange,
}: HideDownloadedToggleProps) {
  if (!pressed && downloaded === 0) return null
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={pressed}
      title={
        pressed
          ? `${formatCount(downloaded)} downloaded hidden: not shown, counted or downloaded`
          : 'Hide the tracks already downloaded'
      }
      className="aria-pressed:border-primary/60 aria-pressed:bg-primary/15 aria-pressed:text-foreground dark:aria-pressed:bg-primary/20"
      onClick={() => onPressedChange(!pressed)}
    >
      <EyeOff aria-hidden />
      Hide downloaded{' '}
      <span className="text-muted-foreground tabular-nums">({formatCount(downloaded)})</span>
    </Button>
  )
}
