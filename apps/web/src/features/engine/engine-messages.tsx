import { LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { PopoverDescription, PopoverHeader, PopoverTitle } from '@/components/ui/popover.tsx'
import { ApiError } from '@/lib/api.ts'
import { ProblemText } from './problem-text.tsx'
import { startCommand } from './start-command.ts'

/** The popover body while the first health check runs. */
export function CheckingMessage({ title }: { title: string }) {
  return (
    <PopoverHeader>
      <PopoverTitle>{title}</PopoverTitle>
      <PopoverDescription>
        Looking for yt-dlp, ffmpeg and ffprobe. The first check can take a few seconds.
      </PopoverDescription>
    </PopoverHeader>
  )
}

/** The popover body when the request never reached our server. */
export function OfflineMessage({ title, onRetry }: { title: string; onRetry: Retry }) {
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>
          <ProblemText
            message={`The DJ Scraper server isn't running, so links can't be resolved or downloaded. Start it with \`${startCommand()}\` in the project folder.`}
          />
        </PopoverDescription>
      </PopoverHeader>
      <RetryRow note="This status reconnects by itself." onRetry={onRetry} />
    </>
  )
}

/** The popover body when the server answered with an error, or with a body we can't read. */
export function UnexpectedMessage({
  title,
  error,
  onRetry,
}: {
  title: string
  error: Error
  onRetry: Retry
}) {
  const api = error instanceof ApiError && error.kind === 'api'
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>
          {api ? (
            'The server refused the engine check.'
          ) : (
            <ProblemText
              message={`The server's reply doesn't match this app. If you just updated, restart \`${startCommand()}\`.`}
            />
          )}
        </PopoverDescription>
      </PopoverHeader>
      <p className="rounded-md bg-muted/50 p-2 font-mono text-xs break-words text-muted-foreground">
        {errorDetail(error)}
      </p>
      <RetryRow onRetry={onRetry} />
    </>
  )
}

/** E.g. "HTTP 403 forbidden: Origin not allowed", or just the message when no reply came. */
function errorDetail(error: Error): string {
  if (!(error instanceof ApiError) || error.status === undefined) return error.message
  const code = error.code === undefined ? '' : ` ${error.code}`
  return `HTTP ${error.status}${code}: ${error.message}`
}

/** Refetches the health check; settles when that attempt is over, whatever its outcome. */
type Retry = () => Promise<unknown>

/**
 * A failed retry leaves the popover as it was, so say when it ran. A successful one replaces this
 * whole message with the engine details.
 */
function RetryRow({ note, onRetry }: { note?: string; onRetry: Retry }) {
  const [pending, setPending] = useState(false)
  const [triedAt, setTriedAt] = useState<string>()
  const retry = () => {
    setPending(true)
    void onRetry().finally(() => {
      setPending(false)
      setTriedAt(new Date().toLocaleTimeString())
    })
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <p role="status" className="text-xs text-muted-foreground">
        {triedAt === undefined ? note : `Tried again at ${triedAt}, no luck.`}
      </p>
      <Button variant="outline" size="sm" disabled={pending} focusableWhenDisabled onClick={retry}>
        {pending ? (
          <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
        ) : (
          <RefreshCw aria-hidden />
        )}
        Try now
      </Button>
    </div>
  )
}
