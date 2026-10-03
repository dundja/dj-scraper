import { type DownloadFormat, DownloadFormatSchema } from '@dj-scraper/shared'

/**
 * What "Original" does, in one place: the server copies the stream as is and fetches artwork only
 * when the file can hold it (finalize-plan.ts `canHoldCover`): never for YouTube, whose original
 * is Opus in WebM.
 */
export const ORIGINAL_FORMAT_DESCRIPTION =
  "No conversion. From YouTube that's Opus/WebM: no artwork, and DJ apps won't load it."

export type FormatOption = {
  value: DownloadFormat
  /**
   * The format's name in the select, e.g. "M4A (AAC)". No bitrate: the closed select sits beside
   * the source, and an MP3 source keeps its own (ADR-015).
   */
  label: string
  /**
   * One line on what the file will be, honest about quality (docs/product.md, Settings): every
   * stream is lossy, so a lossless container keeps the source's quality and adds none.
   */
  description: string
}

const FORMATS: Record<DownloadFormat, Omit<FormatOption, 'value'>> = {
  mp3: {
    label: 'MP3',
    description: '320 kbps when converted; an MP3 source keeps its own bitrate.',
  },
  m4a: {
    label: 'M4A (AAC)',
    description: 'An AAC source is copied as is; anything else becomes AAC 256 kbps.',
  },
  aiff: {
    label: 'AIFF',
    description:
      "Lossless container for DJ apps, with tags and artwork: the source's quality, no more.",
  },
  wav: {
    label: 'WAV',
    description: "Lossless container, no artwork and minimal tags: the source's quality, no more.",
  },
  flac: {
    label: 'FLAC',
    description:
      "Lossless container, 16-bit, with tags and artwork: the source's quality, no more.",
  },
  original: { label: 'Original', description: ORIGINAL_FORMAT_DESCRIPTION },
}

/** Every download format in the contract's order, for the format select. */
export const FORMAT_OPTIONS: readonly FormatOption[] = DownloadFormatSchema.options.map(
  (value) => ({ value, ...FORMATS[value] }),
)

/** A format's name as the select shows it, e.g. "M4A (AAC)". */
export function formatLabel(format: DownloadFormat): string {
  return FORMATS[format].label
}
