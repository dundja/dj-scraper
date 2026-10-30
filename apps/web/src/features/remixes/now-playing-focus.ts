/**
 * The now-playing bar is about to go (Close, or cancelling the preparation from it): if the focus
 * is inside it, hand it to the row's Play button for the upload `key` (`data-remix-play`), or, when
 * that row isn't on the page, to the link box (`data-download-shortcut`), so it doesn't fall back
 * to the page's start.
 */
export function handFocusFromBar(bar: HTMLElement | null, key: string | null) {
  if (bar === null || !bar.contains(document.activeElement)) return
  const play = [...document.querySelectorAll<HTMLElement>('[data-remix-play]')].find(
    (button) => button.dataset.remixPlay === key,
  )
  ;(play ?? document.querySelector<HTMLElement>('[data-download-shortcut]'))?.focus()
}
