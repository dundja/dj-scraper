import { Link2 } from 'lucide-react'
import { type RefObject, useEffect, useId } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group.tsx'
import { cn } from '@/lib/utils.ts'
import { findLink } from './paste-text.ts'
import { UrlBadge } from './url-badge.tsx'
import type { UrlVerdict } from './url-verdict.ts'
import { usePasteShortcut } from './use-paste-shortcut.ts'

type PasteBoxProps = {
  /** The link box, which the page focuses after actions that remove the button pressed. */
  inputRef: RefObject<HTMLInputElement | null>
  text: string
  verdict: UrlVerdict
  /** The user tried to load this text and it isn't a link we take: show why as an error. */
  refused: boolean
  /** A resolve is running: Esc cancels it. */
  pending: boolean
  onTextChange: (text: string) => void
  /** Enter or Go with the box's text, or a link pasted into the box. */
  onLoad: (text: string) => void
  onCancel: () => void
}

/**
 * The URL box at the top of the page, focused on load. The badge at its end guesses what the link
 * is as you type; Enter or Go loads it, and pasting a link into it loads it at once. ⌘V outside a
 * text field pastes into it.
 */
export function PasteBox({
  inputRef,
  text,
  verdict,
  refused,
  pending,
  onTextChange,
  onLoad,
  onCancel,
}: PasteBoxProps) {
  const id = useId()
  const badgeId = `${id}-badge`
  const messageId = `${id}-message`

  useEffect(() => {
    inputRef.current?.focus()
  }, [inputRef])
  usePasteShortcut(inputRef)

  const hasBadge = verdict.status === 'ok' || verdict.status === 'drm'
  // Text that isn't a link says why as you type; an empty box only once you try to load it.
  const message =
    verdict.status === 'ok' || (verdict.status === 'empty' && !refused)
      ? undefined
      : verdict.message
  const describedBy = [hasBadge && badgeId, message !== undefined && messageId].filter(Boolean)

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onLoad(text)
      }}
      className="flex shrink-0 flex-col gap-1.5 px-4 pt-4 pb-3"
    >
      <label htmlFor={`${id}-url`} className="sr-only">
        YouTube or SoundCloud link
      </label>
      <div className="flex items-center gap-2">
        <InputGroup className="h-9 bg-card/40">
          <InputGroupAddon>
            <Link2 aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            id={`${id}-url`}
            type="url"
            inputMode="url"
            value={text}
            placeholder="Paste or type a YouTube or SoundCloud link"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={refused || undefined}
            aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
            onChange={(event) => onTextChange(event.target.value)}
            onPaste={(event) => {
              // A link replaces whatever was in the box and loads; other text pastes as usual.
              const link = findLink(event.clipboardData.getData('text/plain'))
              if (link === undefined) return
              event.preventDefault()
              onLoad(link)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !pending) return
              event.preventDefault()
              onCancel()
            }}
          />
          {hasBadge && (
            <InputGroupAddon align="inline-end">
              <UrlBadge id={badgeId} verdict={verdict} />
            </InputGroupAddon>
          )}
        </InputGroup>
        <Button type="submit" size="lg" className="px-3.5">
          Go
        </Button>
      </div>
      {message !== undefined && (
        <p
          id={messageId}
          className={cn('px-0.5 text-xs', refused ? 'text-destructive' : 'text-muted-foreground')}
        >
          {message}
        </p>
      )}
    </form>
  )
}
