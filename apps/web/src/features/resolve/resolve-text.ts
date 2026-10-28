import {
  type AmbiguousListKind,
  type CollectionKind,
  MAX_MIX_ENTRIES,
  MAX_PASTED_LINKS,
  type Platform,
  type ResolveResult,
} from '@dj-scraper/shared'
import { loadingShape, type ResultShape } from './url-verdict.ts'
import type { Submission } from './use-resolve.ts'

/** The words of the "this track or the whole list?" choice, by the kind of list. */
export type AmbiguousWording = {
  question: string
  /** The choice that keeps the track already looked up. */
  track: string
  /** The choice that lists the whole list. */
  list: string
  /** The way out when the track itself can't be looked up (private, age-restricted…). */
  openList: string
  /** Shown under the question: what the link is, and for a mix that it never ends. */
  note: string
}

const MIX_FIRST = `first ${MAX_MIX_ENTRIES}`

const WORDING: Record<AmbiguousListKind, AmbiguousWording> = {
  playlist: {
    question: 'This track or the whole playlist?',
    track: 'This track',
    list: 'Whole playlist',
    openList: 'Open the playlist',
    note: 'The link opens a track inside a playlist.',
  },
  album: {
    question: 'This track or the whole album?',
    track: 'This track',
    list: 'Whole album',
    openList: 'Open the album',
    note: 'The link opens a track inside an album.',
  },
  mix: {
    question: 'This track or the mix?',
    track: 'This track',
    list: `Load the mix (${MIX_FIRST})`,
    openList: `Open the mix (${MIX_FIRST})`,
    note: `The link opens a track inside a YouTube Mix, which never ends: loading it lists the ${MIX_FIRST} tracks.`,
  },
}

export function ambiguousWording(kind: AmbiguousListKind): AmbiguousWording {
  return WORDING[kind]
}

const LOADING_LABELS: Record<ResultShape, string> = {
  track: 'Loading the track…',
  list: 'Loading the list…',
  link: 'Loading the link…',
}

export function loadingLabel(shape: ResultShape): string {
  return LOADING_LABELS[shape]
}

/** The skeleton a load shows: a list for pasted links, else what its link most likely is. */
export function submissionShape(submission: Submission): ResultShape {
  return submission.kind === 'links' ? 'list' : loadingShape(submission.url, submission.mode)
}

/** "Loading the track…", or for pasted Spotify links "Loading 312 Spotify tracks…". */
export function submissionLoadingLabel(submission: Submission): string {
  if (submission.kind === 'links') {
    return `Loading ${countOf(submission.urls.length, 'Spotify track')}…`
  }
  return loadingLabel(submissionShape(submission))
}

/**
 * Under the emptied paste box after a paste of several Spotify track links, which a one-link box
 * can't hold: what became of them.
 */
export function pastedLinksNote(count: number): string {
  // findSpotifyTrackLinks stops at the cap, so a longer paste is cut there: say so.
  if (count >= MAX_PASTED_LINKS) {
    return `Pasted the first ${countOf(MAX_PASTED_LINKS, 'Spotify track link')}, the most one list takes: paste any others on their own.`
  }
  return `Pasted ${countOf(count, 'Spotify track link')}: they load as one list.`
}

/** How long to wait before a list's loading state shows the seconds and the note below. */
export const SLOW_AFTER_SECONDS = 3

/**
 * Why a list takes a while: YouTube pages 100 rows per request (a 1,788-video channel took 21 s,
 * 5,001 rows up to 56 s). SoundCloud and other sites have no measured numbers.
 */
export function bigListNote(platform: Platform): string {
  return platform === 'youtube'
    ? 'Big lists take a while: 1,800 videos ≈ 20 s, 5,000 ≈ 1 min.'
    : 'Big lists take a while.'
}

const COLLECTION_NOUNS: Record<CollectionKind, string> = {
  playlist: 'Playlist',
  album: 'Album',
  set: 'Set',
  channel: 'Channel',
  likes: 'Likes',
  mix: 'Mix',
  links: 'Pasted links',
  other: 'List',
}

const numberFormat = new Intl.NumberFormat('en-US')

/** "1 track", "1,800 tracks". */
export function countOf(count: number, noun: string): string {
  return `${numberFormat.format(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** What the status region announces once a link has loaded. */
export function resultAnnouncement(result: ResolveResult): string {
  switch (result.kind) {
    case 'track':
      return `Track: ${result.track.title}`
    case 'ambiguous':
      return ambiguousWording(result.collectionKind).question
    case 'collection': {
      const { kind, title, entries, lists } = result.collection
      const contents =
        entries.length > 0 || lists === undefined
          ? countOf(entries.length, 'track')
          : countOf(lists.length, 'list')
      // Pasted links have no page of their own: the title already says what they are.
      return kind === 'links'
        ? `${title}, ${contents}`
        : `${COLLECTION_NOUNS[kind]}: ${title}, ${contents}`
    }
  }
}
