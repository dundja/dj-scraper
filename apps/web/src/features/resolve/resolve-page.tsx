import type { ResolveMode } from '@dj-scraper/shared'
import { useMemo, useRef, useState } from 'react'
import { DropOverlay } from './drop-overlay.tsx'
import { PasteBox } from './paste-box.tsx'
import { ResolveOutcome } from './resolve-outcome.tsx'
import { pastedLinksNote, resultAnnouncement, submissionLoadingLabel } from './resolve-text.ts'
import { type UrlVerdict, urlVerdict } from './url-verdict.ts'
import { useLinkDrop } from './use-link-drop.ts'
import { usePasteAnywhere } from './use-paste-anywhere.ts'
import { type Resolver, useResolve } from './use-resolve.ts'

/**
 * The home page: paste, drop or type a link, and see what it is. Every way in goes through
 * `load`: the text lands in the paste box (which takes the focus), and a link we take resolves at
 * once (aborting the one before); anything else says why in the box instead. A paste or drop of
 * two or more Spotify track links goes through `loadLinks` and loads them as one list: the box,
 * which holds one link, is emptied and says how many were pasted.
 */
export function ResolvePage() {
  const resolver = useResolve()
  const box = useRef<HTMLInputElement>(null)
  const focusBox = () => box.current?.focus()
  const [text, setText] = useState('')
  // The text the user tried to load and we refused (not a link, a DRM service), until edited.
  const [refusedText, setRefusedText] = useState<string>()
  const verdict = useMemo(() => urlVerdict(text), [text])
  const refused = refusedText === text && verdict.status !== 'ok'
  // How many Spotify track links the last paste loaded as one list, until the box is used again.
  const [pastedLinks, setPastedLinks] = useState<number>()

  const changeText = (input: string) => {
    setText(input)
    setPastedLinks(undefined)
  }

  const load = (input: string, mode: ResolveMode = 'auto') => {
    changeText(input)
    focusBox()
    const next = urlVerdict(input)
    if (next.status !== 'ok') {
      // A refused paste leaves a running resolve (and the last result) alone, but not an error,
      // whose Try again would load the old link while the box shows the refused text.
      setRefusedText(input)
      resolver.dismissError()
      return
    }
    setRefusedText(undefined)
    resolver.resolve(next.url, mode)
  }

  const loadLinks = (urls: readonly string[]) => {
    setText('')
    setRefusedText(undefined)
    setPastedLinks(urls.length)
    focusBox()
    resolver.resolveLinks(urls)
  }

  usePasteAnywhere(load, loadLinks)
  const dragging = useLinkDrop(load, loadLinks, box)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Load a link</h1>
      <PasteBox
        inputRef={box}
        text={text}
        verdict={verdict}
        refused={refused}
        pending={resolver.status === 'pending'}
        onTextChange={changeText}
        onLoad={load}
        onLoadLinks={loadLinks}
        note={pastedLinks === undefined ? undefined : pastedLinksNote(pastedLinks)}
        onCancel={resolver.cancel}
      />
      <ResolveOutcome
        resolver={resolver}
        onLoad={load}
        onLoadLinks={loadLinks}
        onFocusBox={focusBox}
      />
      <p role="status" className="sr-only">
        {announcement(resolver, refused ? verdict : undefined)}
      </p>
      {dragging && <DropOverlay />}
    </div>
  )
}

/**
 * The status region's text: a refusal, loading, what loaded, or a cancel. A failure isn't here:
 * the error alert announces itself.
 */
function announcement(resolver: Resolver, refusal: UrlVerdict | undefined): string {
  if (refusal !== undefined && refusal.status !== 'ok') return refusal.message
  const { status, submission, result } = resolver
  if (status === 'pending' && submission !== undefined) {
    return submissionLoadingLabel(submission)
  }
  if (status === 'success' && result !== undefined) return resultAnnouncement(result)
  return resolver.canceled ? 'Canceled.' : ''
}
