import { Music } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils.ts'

type ArtworkProps = {
  /** The thumbnail URL; without one (or when it fails to load) a neutral placeholder shows. */
  src: string | undefined
  /** Empty (the default) when the title is next to it, which makes the artwork decorative. */
  alt?: string
  /** Width and height in px: the artwork is square, cropped to fill (YouTube's are 16:9). */
  size: number
  className?: string
}

/**
 * A track's or list's artwork, loaded lazily. No referrer goes to the image host, so YouTube and
 * SoundCloud don't learn which local page shows their thumbnails.
 */
export function Artwork({ src, alt = '', size, className }: ArtworkProps) {
  // The src that failed, so a new src gets its own try without an effect.
  const [failedSrc, setFailedSrc] = useState<string>()
  const box = cn(
    'shrink-0 bg-muted',
    size <= 40 ? 'rounded-sm' : size <= 96 ? 'rounded-md' : 'rounded-lg',
    className,
  )

  if (src === undefined || src === failedSrc) {
    const style = { width: size, height: size }
    const placeholder = cn(box, 'flex items-center justify-center text-muted-foreground')
    const icon = <Music aria-hidden style={{ width: size / 2.5, height: size / 2.5 }} />
    return alt === '' ? (
      <div aria-hidden data-slot="artwork" className={placeholder} style={style}>
        {icon}
      </div>
    ) : (
      <div role="img" aria-label={alt} data-slot="artwork" className={placeholder} style={style}>
        {icon}
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      data-slot="artwork"
      className={cn(box, 'object-cover')}
      style={{ width: size, height: size }}
      onError={() => setFailedSrc(src)}
    />
  )
}
