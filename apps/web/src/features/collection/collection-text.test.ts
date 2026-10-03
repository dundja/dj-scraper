import { type CollectionEntry, CreateDownloadsResponseSchema } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import {
  bigPlaylist,
  collectionWith,
  playlist,
  scSet,
  userPage,
  userPageWithLists,
} from '@/test/resolve.ts'
import {
  countOf,
  downloadButtonText,
  formatCount,
  kindLabel,
  listNoun,
  listsNote,
  listTitle,
  queuedText,
  selectionCountText,
  selectionText,
  skippedNote,
  totalDurationText,
  trackCountText,
  truncatedNote,
} from './collection-text.ts'
import { tableRows } from './rows.ts'

const rowsOf = (entries: readonly CollectionEntry[]) =>
  tableRows(entries.map((entry) => ({ entry, state: entry.partial ? 'pending' : 'ready' })))

describe('counts', () => {
  it('groups thousands the English way', () => {
    expect(formatCount(5000)).toBe('5,000')
    expect(formatCount(12)).toBe('12')
  })

  it('says one or many', () => {
    expect(countOf(1, 'track')).toBe('1 track')
    expect(countOf(0, 'track')).toBe('0 tracks')
    expect(countOf(1800, 'row')).toBe('1,800 rows')
    expect(countOf(2, 'match', 'matches')).toBe('2 matches')
  })
})

describe('kindLabel', () => {
  it('names each kind', () => {
    expect(kindLabel(playlist)).toBe('Playlist')
    expect(kindLabel(scSet)).toBe('Set')
    expect(kindLabel({ kind: 'album', platform: 'youtube' })).toBe('Album')
    expect(kindLabel({ kind: 'mix', platform: 'youtube' })).toBe('Mix')
    expect(kindLabel({ kind: 'likes', platform: 'soundcloud' })).toBe('Likes')
    expect(kindLabel({ kind: 'other', platform: 'other' })).toBe('List')
  })

  it('calls a YouTube channel a channel and a SoundCloud user page a profile', () => {
    expect(kindLabel({ kind: 'channel', platform: 'youtube' })).toBe('Channel')
    expect(kindLabel(userPage)).toBe('Profile')
  })
})

describe('trackCountText', () => {
  it('counts the rows', () => {
    expect(trackCountText(playlist)).toBe('30 tracks')
    const one = collectionWith(playlist, { entries: playlist.entries.slice(0, 1) })
    expect(trackCountText({ ...one, trackCount: undefined })).toBe('1 track')
    expect(trackCountText({ ...one, trackCount: 1 })).toBe('1 track')
  })

  it('says how many the platform has when the listing holds fewer', () => {
    expect(trackCountText(collectionWith(playlist, { trackCount: 214 }))).toBe('30 of 214 tracks')
    expect(trackCountText(collectionWith(bigPlaylist(5000), { trackCount: 5321 }))).toBe(
      '5,000 of 5,321 tracks',
    )
  })
})

describe('totalDurationText', () => {
  it('sums the known durations, approximately when a downloadable row has none', () => {
    // 13,400 s without the two unavailable rows; row 14 (a past live stream) has no duration.
    expect(totalDurationText(playlist, rowsOf(playlist.entries))).toBe('≈ 3 h 43 min')
  })

  it('is exact when every downloadable row has a duration', () => {
    const entries = playlist.entries.slice(0, 4)
    // 384 + 412 + 365 s; the private row 2 doesn't count.
    expect(totalDurationText(collectionWith(playlist, { entries }), rowsOf(entries))).toBe('19 min')
  })

  it('takes the platform total when there is one, even while rows are partial', () => {
    expect(totalDurationText(scSet, rowsOf(scSet.entries))).toBe('51 min')
  })

  it('is undefined while no duration is known', () => {
    const partial = scSet.entries.slice(2)
    const collection = collectionWith(scSet, { entries: partial, durationSec: undefined })
    expect(totalDurationText(collection, rowsOf(partial))).toBeUndefined()
    expect(totalDurationText(userPageWithLists, [])).toBeUndefined()
  })
})

describe('truncatedNote', () => {
  it('is undefined for a whole list', () => {
    expect(truncatedNote(playlist)).toBeUndefined()
  })

  it('says the listing cap cut the list', () => {
    expect(truncatedNote(collectionWith(bigPlaylist(5000), { truncated: true }))).toBe(
      'Showing the first 5,000 tracks.',
    )
  })

  it('explains a mix', () => {
    const mix = collectionWith(playlist, { kind: 'mix', truncated: true })
    expect(truncatedNote(mix)).toBe('A mix never ends: showing its first 30 tracks.')
  })
})

describe('lists', () => {
  it('names the lists by platform and tab', () => {
    expect(listNoun(userPageWithLists, 4)).toBe('4 sets')
    expect(listNoun(userPage, 1)).toBe('1 set')
    const albums = collectionWith(userPageWithLists, {
      url: 'https://soundcloud.com/the-concept-band/albums/',
    })
    expect(listNoun(albums, 2)).toBe('2 albums')
    expect(listNoun(playlist, 3)).toBe('3 playlists')
  })

  it('notes the lists a page with tracks links to', () => {
    expect(listsNote(userPage)).toBe('This page also lists 1 set.')
    expect(listsNote(playlist)).toBeUndefined()
  })

  it('titles a list, or names it after its URL', () => {
    expect(listTitle({ url: 'https://soundcloud.com/x/sets/royal-ep', title: 'Royal EP' })).toBe(
      'Royal EP',
    )
    expect(listTitle({ url: 'https://soundcloud.com/x/sets/caf%C3%A9-nights' })).toBe('café-nights')
    expect(listTitle({ url: 'https://soundcloud.com/x/sets/100%-bad' })).toBe('100%-bad')
    expect(listTitle({ url: 'https://soundcloud.com/' })).toBe('https://soundcloud.com/')
  })

  it("names an untitled secret set by its set, never by the link's token", () => {
    const secret = listTitle({ url: 'https://soundcloud.com/x/sets/royal-ep/s-8kQ2xYabc' })
    expect(secret).toBe('royal-ep')
    expect(listTitle({ url: 'https://m.soundcloud.com/x/sets/night-drive/s-8Pjrp' })).toBe(
      'night-drive',
    )
    // A token in the query leaves the set's name last.
    expect(listTitle({ url: 'https://soundcloud.com/x/sets/royal-ep?secret_token=s-8Pjrp' })).toBe(
      'royal-ep',
    )
    expect(
      listTitle({ url: 'https://soundcloud.com/x/sets/royal-ep/s-8Pjrp', title: 'Royal EP' }),
    ).toBe('Royal EP')
  })
})

describe('skippedNote', () => {
  it('counts the rows that arent tracks', () => {
    expect(skippedNote(collectionWith(playlist, { skippedEntries: 2 }))).toBe(
      "2 rows aren't tracks.",
    )
    expect(skippedNote(collectionWith(playlist, { skippedEntries: 1 }))).toBe(
      "1 row isn't a track.",
    )
    expect(skippedNote(playlist)).toBeUndefined()
  })

  it('leaves out the lists, which have their own note', () => {
    expect(skippedNote(userPage)).toBe("1 other row isn't a track.")
    expect(skippedNote(userPageWithLists)).toBeUndefined()
    const more = collectionWith(userPage, { skippedEntries: 4 })
    expect(skippedNote(more)).toBe("3 other rows aren't tracks.")
  })
})

describe('selectionText', () => {
  it('says how many and how long', () => {
    expect(selectionText({ count: 27, durationSec: 13102, withoutDuration: 1 })).toBe(
      '27 selected · 3 h 38 min · 1 without a duration',
    )
    expect(selectionText({ count: 1, durationSec: 245, withoutDuration: 0 })).toBe(
      '1 selected · 4 min',
    )
    expect(selectionText({ count: 6, durationSec: 0, withoutDuration: 6 })).toBe(
      '6 selected · 6 without a duration',
    )
  })

  it('says when nothing is selected', () => {
    expect(selectionText({ count: 0, durationSec: 0, withoutDuration: 0 })).toBe('None selected')
  })
})

describe('selectionCountText', () => {
  it('says only how many', () => {
    expect(selectionCountText(5000)).toBe('5,000 selected')
    expect(selectionCountText(1)).toBe('1 selected')
    expect(selectionCountText(0)).toBe('None selected')
  })
})

describe('downloadButtonText', () => {
  it('counts the tracks, or asks for some', () => {
    expect(downloadButtonText(27)).toBe('Download 27 tracks')
    expect(downloadButtonText(1)).toBe('Download 1 track')
    expect(downloadButtonText(5000)).toBe('Download 5,000 tracks')
    expect(downloadButtonText(0)).toBe('Select tracks')
  })
})

describe('queuedText', () => {
  const response = (jobs: number, duplicates: number) =>
    CreateDownloadsResponseSchema.parse({
      ...(duplicates < jobs ? { batchId: testUuid(500) } : {}),
      jobIds: Array.from({ length: jobs }, (_, n) => testUuid(600 + n)),
      duplicates,
    })

  it('says how many were queued', () => {
    expect(queuedText(response(27, 0))).toBe('Queued 27 tracks — see Downloads.')
    expect(queuedText(response(1, 0))).toBe('Queued 1 track — see Downloads.')
  })

  it('says how many were in the queue already', () => {
    expect(queuedText(response(27, 1))).toBe(
      'Queued 26 tracks — see Downloads. 1 was already in the queue.',
    )
    expect(queuedText(response(27, 3))).toBe(
      'Queued 24 tracks — see Downloads. 3 were already in the queue.',
    )
  })

  it('says when every track was in the queue already', () => {
    expect(queuedText(response(27, 27))).toBe(
      'All 27 tracks are already in the queue — see Downloads.',
    )
    expect(queuedText(response(1, 1))).toBe('This track is already in the queue — see Downloads.')
  })
})
