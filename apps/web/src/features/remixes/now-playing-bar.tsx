import { X } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
import { handFocusFromBar } from './now-playing-focus.ts'
import {
  InlineSpeed,
  NowPlayingDownload,
  NowPlayingInfo,
  PlayerError,
  PlayPauseButton,
  SeekBar,
  SpeedPopover,
} from './now-playing-parts.tsx'
import { type NowPlaying, type PreviewState, stopPreview, togglePreview } from './preview-player.ts'
import { previewMessage } from './remix-text.ts'
import { usePreviewState } from './use-preview-player.ts'

/**
 * The now-playing bar (ADR-031): across the whole window under the page and the downloads, while a
 * remix is being prepared, plays, is paused or failed; absent otherwise. It is the one player's
 * face: what plays and from where, play/pause, the seek bar, the speed grid (one row on a wide
 * window, a popover below), Download for that upload, and Close.
 *
 * It sits in the shell's flow, so it never covers the page: on lg+ the columns above give it its
 * 72 px, and below lg it sticks to the window's bottom as the page's last part (two rows: the seek
 * bar over the controls).
 */
export function NowPlayingBar() {
  const state = usePreviewState()
  const { nowPlaying, status } = state
  const on = nowPlaying !== null && status !== 'idle'
  return (
    <>
      {/*
        What the player says, outside the bar and always in the page: a live region added
        together with its first words isn't read, so "Preparing audio…" would go unsaid.
      */}
      <p role="status" data-slot="now-playing-status" className="sr-only">
        {on ? previewMessage(status, nowPlaying.upload.platform) : ''}
      </p>
      {on && <Bar state={state} nowPlaying={nowPlaying} />}
    </>
  )
}

function Bar({ state, nowPlaying }: { state: PreviewState; nowPlaying: NowPlaying }) {
  const bar = useRef<HTMLElement>(null)
  const playPause = useRef<HTMLButtonElement>(null)
  const { status } = state
  const { upload } = nowPlaying
  const message = previewMessage(status, upload.platform)

  const toggle = () => {
    // Cancelling the preparation takes the bar away, as Close does.
    if (status === 'preparing') handFocusFromBar(bar.current, state.key)
    togglePreview(upload, nowPlaying)
  }

  const retry = () => {
    // Try again goes as the audio is prepared again: its focus moves to play/pause (now Cancel).
    const fromError = bar.current?.querySelector('[role="alert"]')?.contains(document.activeElement)
    togglePreview(upload, nowPlaying)
    if (fromError === true) playPause.current?.focus()
  }

  const close = () => {
    // The bar goes with the audio: the focus goes to the row's Play button, or the link box.
    handFocusFromBar(bar.current, state.key)
    stopPreview()
  }

  return (
    <section
      ref={bar}
      aria-label="Now playing"
      data-slot="now-playing"
      data-status={status}
      className={cn(
        'sticky bottom-0 z-10 grid shrink-0 items-center border-t bg-card',
        // Below lg: the seek bar (or what the player says) over cover, names and the controls.
        'grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-x-2 gap-y-1.5 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        // lg+: one 72 px row.
        'lg:h-18 lg:grid-cols-[minmax(0,17rem)_auto_minmax(10rem,1fr)_auto_auto_auto] lg:gap-x-4 lg:px-4 lg:py-0',
      )}
    >
      <div className="col-start-1 row-start-2 min-w-0 lg:row-start-1">
        <NowPlayingInfo nowPlaying={nowPlaying} />
      </div>
      <div className="col-start-2 row-start-2 lg:row-start-1">
        <PlayPauseButton ref={playPause} status={status} onToggle={toggle} />
      </div>
      <div className="col-span-full row-start-1 min-w-0 lg:col-span-1 lg:col-start-3">
        {/* Said by the status region above; shown here while there's nothing else to show. */}
        {status === 'preparing' && (
          <p aria-hidden className="flex h-6 items-center text-xs text-muted-foreground">
            {message}
          </p>
        )}
        {status === 'error' && <PlayerError error={state.error} onRetry={retry} />}
        {(status === 'playing' || status === 'paused') && (
          <SeekBar state={state} durationSec={upload.durationSec} />
        )}
      </div>
      <div className="col-start-3 row-start-2 lg:col-start-4 lg:row-start-1">
        {status !== 'error' && (
          <>
            <div className="hidden min-[1400px]:flex">
              <InlineSpeed rate={state.rate} preservesPitch={state.preservesPitch} />
            </div>
            <div className="min-[1400px]:hidden">
              <SpeedPopover rate={state.rate} preservesPitch={state.preservesPitch} />
            </div>
          </>
        )}
      </div>
      <div className="col-start-4 row-start-2 lg:col-start-5 lg:row-start-1">
        <NowPlayingDownload key={state.key} nowPlaying={nowPlaying} />
      </div>
      <div className="col-start-5 row-start-2 lg:col-start-6 lg:row-start-1">
        <Button variant="ghost" size="icon-sm" aria-label="Close player" onClick={close}>
          <X aria-hidden />
        </Button>
      </div>
    </section>
  )
}
