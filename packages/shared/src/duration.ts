/**
 * A track length the way players show it: `m:ss` under an hour ("3:07"), `h:mm:ss` from an hour on
 * ("1:02:03"). Rounds to the nearest second (SoundCloud reports milliseconds: 1398.595 → "23:19").
 * Durations come from the contract, which allows no negative or infinite values; such input gives
 * "–:––" rather than a misleading "0:00".
 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–:––'
  const total = Math.round(sec)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  if (hours === 0) return `${minutes}:${seconds}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
}
