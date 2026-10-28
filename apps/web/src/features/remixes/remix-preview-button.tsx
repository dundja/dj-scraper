import type { RemixUpload } from '@dj-scraper/shared'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import type { PreviewStatus } from './preview-player.ts'

type RemixPreviewButtonProps = {
  upload: RemixUpload
  status: PreviewStatus
  onToggle: () => void
}

/**
 * Play, then Pause while it plays. While the server prepares the audio it shows a spinner and a
 * click cancels. The accessible name carries the upload's title, like the Download button's.
 */
export function RemixPreviewButton({ upload, status, onToggle }: RemixPreviewButtonProps) {
  const preparing = status === 'preparing'
  const playing = status === 'playing'
  let label = `Play ${upload.title}`
  if (playing) label = `Pause ${upload.title}`
  else if (preparing) label = `Cancel preparing ${upload.title}`
  let icon = <Play aria-hidden />
  if (playing) icon = <Pause aria-hidden />
  else if (preparing) icon = <Spinner aria-hidden className="motion-reduce:animate-none" />
  return (
    <Button
      variant={status === 'idle' ? 'outline' : 'secondary'}
      size="icon-sm"
      aria-label={label}
      title={preparing ? 'Preparing audio… Click to cancel' : undefined}
      onClick={onToggle}
    >
      {icon}
    </Button>
  )
}
