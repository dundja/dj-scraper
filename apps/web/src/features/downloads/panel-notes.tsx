import type { QueueState } from '@dj-scraper/shared'
import { CircleAlert, CirclePause, Timer, WifiOff, X } from 'lucide-react'
import { type ReactNode, type RefObject, useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import type { ErrorDescription } from '@/lib/error-text.ts'
import type { EventsConnection } from '@/lib/events.ts'
import { focusNextAfter } from '@/lib/focus.ts'
import { cn } from '@/lib/utils.ts'
import { type QueueNote, queueNotes } from './panel-text.ts'

type NotesProps = { connection: EventsConnection; queue: QueueState | undefined }

/**
 * What holds the downloads back: a lost event stream, and platforms the queue pauses or paces.
 * The lost stream and the pauses are one live region, so each is announced when it starts. The
 * paced notes stay outside it: a paced platform's next start moves with every start, and its
 * note comes and goes as the queue waits for a slot instead, which would be read out all through
 * a long batch.
 */
export function PanelNotes({ connection, queue }: NotesProps) {
  const notes = queueNotes(queue)
  return (
    <div className="flex shrink-0 flex-col">
      <div aria-live="polite" className="flex flex-col">
        {connection === 'down' && (
          <Note icon={<WifiOff aria-hidden />} className="text-warning">
            Live updates lost: reconnecting…
          </Note>
        )}
        {notes
          .filter((note) => note.kind === 'paused')
          .map((note) => (
            <QueueNoteLine key={note.platform} note={note} />
          ))}
      </div>
      {notes
        .filter((note) => note.kind === 'paced')
        .map((note) => (
          <QueueNoteLine key={note.platform} note={note} />
        ))}
    </div>
  )
}

function QueueNoteLine({ note }: { note: QueueNote }) {
  return (
    <Note
      icon={note.kind === 'paused' ? <CirclePause aria-hidden /> : <Timer aria-hidden />}
      className={note.kind === 'paused' ? 'text-warning' : 'text-muted-foreground'}
    >
      {note.text}
      {note.hint !== undefined && (
        <span className="block text-muted-foreground">
          <ProblemText message={note.hint} />
        </span>
      )}
    </Note>
  )
}

type ErrorProps = {
  error: ErrorDescription
  onDismiss: () => void
  /** Takes the focus from Dismiss when no control follows the alert. */
  fallbackFocus: RefObject<HTMLElement | null>
}

/**
 * A bulk action that failed: what it couldn't do, the reason and a next step. Dismiss removes it
 * with its button, so the focus moves on as Tab would (else to `fallbackFocus`).
 */
export function PanelError({ error, onDismiss, fallbackFocus }: ErrorProps) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs"
    >
      <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1">
        <span className="text-destructive">{error.message}</span>
        {error.hint !== undefined && (
          <span className="block text-muted-foreground">
            <ProblemText message={error.hint} />
          </span>
        )}
      </p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="-my-0.5 text-muted-foreground"
        onClick={() => {
          if (!focusNextAfter(ref.current)) fallbackFocus.current?.focus()
          onDismiss()
        }}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

function Note({
  icon,
  className,
  children,
}: {
  icon: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2 text-xs [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0',
        className,
      )}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
