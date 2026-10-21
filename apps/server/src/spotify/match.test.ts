import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Candidate,
  MAX_DURATION_DELTA_SEC,
  MAX_QUERY_LENGTH,
  parseSearchResults,
  pickMatch,
  rankMatches,
  SEARCH_RESULTS,
  searchQuery,
} from './match.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures')
/** The recorded search (test/fixtures/youtube/README.md): `ytsearch10:Rick Astley - Never Gonna Give You Up`. */
const RECORDED_SEARCH: unknown = JSON.parse(
  readFileSync(path.join(fixturesDir, 'youtube/search.json'), 'utf8'),
)

const c = (id: string, title: string, uploader: string, durationSec: number): Candidate => ({
  id,
  title,
  uploader,
  durationSec,
})

/**
 * Live results of `yt-dlp -J --flat-playlist -- ytsearch10:<searchQuery>` for rows of the recorded
 * Spotify playlists (test/fixtures/spotify), taken 2026-10-21 with yt-dlp 2026.08.19 and cut to what
 * parseSearchResults keeps (id, title, channel, duration). Not fixtures: only these fields matter.
 */
const LIVE = {
  /** Taylor Swift - Patient Zero */
  patient: [
    c('mw3kSNIxjqo', 'Taylor Swift - Patient Zero (Official Music Video)', 'Taylor Swift', 313),
    c('BpR280fXISA', 'Taylor Swift - Patient Zero (Official Lyric Video)', 'Taylor Swift', 229),
    c(
      '0uSORr6EfYM',
      'Taylor Swift  - Patient Zero Official Music Video 4K High Definition Resolution  2160p',
      'Patient Zero ',
      313,
    ),
    c('59o4m222aVw', 'Taylor Swift - Patient Zero (Lyrics)', 'Chill Only', 226),
    c('j8pR1tyoRFc', 'Taylor Swift - Patient Zero (Expanded Video)', 'Taylor Swift', 492),
    c('CWdxwXtoHU4', 'Taylor Swift - Patient Zero Music Video (Cut Version) ', 'Taner', 235),
    c(
      'YZHGzkuzkT4',
      "Travis Kelce VISITED Taylor Swift's Patient Zero Music Video Set",
      'Entertainment Tonight',
      95,
    ),
    c(
      'vtNG9NyO1u4',
      'Top 10 Things You Missed in Taylor Swifts Patient Zero Music Video',
      'MsMojo',
      654,
    ),
    c(
      'XGWysx1Dqww',
      'Taylor Swift LEFT Psychiatrists BLOWN AWAY With Patient Zero Warning',
      'Swift AF News ',
      459,
    ),
    c('uf7vVm9wnSc', 'Taylor Swift - Patient Zero (Lyrics)', 'Trillex Music Group', 227),
  ],
  /** ADÉLA - Nicole Kidman */
  adela: [
    c('3sB4Iv_tM7U', 'ADÉLA - Nicole Kidman', 'ADÉLA', 222),
    c('8i8kpxkzUZk', 'ADÉLA - Nicole Kidman (Lyrics)', 'Lost Panda', 181),
    c('IXA6bQsVNjs', 'Nicole Kidman', 'ADÉLA', 182),
    c('jRpmpCbeW2Y', 'ADÉLA - Nicole Kidman (Lyrics)', 'The Vibe Guide', 182),
    c('SSQpXhXmutI', 'Nicole Kidman | Adela', 'vivalasammm', 212),
    c(
      'RmRMUQIQEZU',
      'Nicole Kidman BURSTS Into Laughter as Raunchy Song About Her Plays at Victoria’s Secret Fashion Show',
      'MEAWW Entertainment',
      153,
    ),
    c(
      'plCKrSSrkBY',
      'Nicole Kidman praises ADÉLA on The Tonight Show with Jimmy Faloon',
      'adelasdiary',
      45,
    ),
    c('0tKsMCc3bUM', 'ADÉLA - Nicole Kidman (Lyrics)', 'Creative Chaos', 183),
    c('ZPIUxWyrquI', 'ADÉLA - Nicole Kidman (Lyrics)', 'Cloudberry', 1201),
    c('MxHHDizdfWM', 'ADÉLA - Nicole Kidman (Lyrics)', 'Aurelia Vance', 1705),
  ],
  /** Olivia Rodrigo, Chappell Roan - expectations (feat. Chappell Roan) */
  expectations: [
    c(
      'gsZauX8gwxo',
      'Olivia Rodrigo - expectations (feat. Chappell Roan) (Official Music Video)',
      'Olivia Rodrigo and Chappell Roan',
      293,
    ),
    c(
      'SmzLX_weRMc',
      'Olivia Rodrigo, Chappell Roan - expectations (Lyric Video)',
      'Olivia Rodrigo',
      225,
    ),
    c('Klf_kf-YAk8', 'Olivia Rodrigo, Chappell Roan - Expectations (Lyrics)', 'Vibe Music', 225),
    c(
      'VYd7DB4kkqg',
      'Olivia Rodrigo - expectations (feat. Chappell Roan) (Official Music Video) | Reaction',
      'The Bascome Twins',
      525,
    ),
    c(
      'VwD4yM8nhMo',
      'Producer Reacts to Olivia Rodrigo & Chappell Roan || Expectations',
      'Blake McLain',
      564,
    ),
    c('nBv5BzFpvvE', 'Olivia Rodrigo - expectations (Lyric Video)', 'Olivia Rodrigo', 223),
    c(
      'MfQ3YXj37rg',
      'Rapper Reacts to Olivia Rodrigo FOR THE FIRST TIME!! | expectations (feat. Chappell Roan) REACTION',
      'Knox Hill',
      708,
    ),
    c(
      'N-GHA9rjAKw',
      'Fantano REACTS to Olivia Rodrigo & Chappell Roan - expectations',
      'Fantano Reacts',
      353,
    ),
    c(
      'OcRCXKXe420',
      'Olivia Rodrigo & Chappell Roan: “expectations”, Music Video & Daisy Chains | Zane Lowe Interview',
      'Apple Music',
      928,
    ),
    c('mON4HoGPN74', 'Olivia Rodrigo & Chappell Roan - expectations (Lyrics)', 'Latin City', 225),
  ],
  /** Daryl Hall & John Oates - Maneater */
  maneater: [
    c(
      'yRYFKcMa_Ek',
      'Daryl Hall & John Oates - Maneater (Official Video)',
      'Daryl Hall & John Oates',
      265,
    ),
    c('oqy2N1jM2tU', 'Maneater', 'Daryl Hall & John Oates', 272),
    c('IqF7S3zXl1A', 'Daryl Hall & John Oates - Maneater (Lyrics)', '7clouds', 270),
    c('vXIPiKb-D2g', 'Maneater (1995) - Hall&Oates', 'konekoxox', 281),
    c('Scd35orIrks', 'Maneater', 'Daryl Hall & John Oates', 273),
    c('jma429JWFCs', 'Hall & Oates - Maneater (Live Aid 1985)', 'Live Aid', 321),
    c('dUtQvwBZ6JI', 'Daryl Hall & John Oates - Maneater (Remastered)', 'Vevo Music Group', 273),
    c('TAM-NNK_LYc', 'Maneater - No hard feelings (Piano scene) HD', 'James', 247),
    c('s9TYZiV_xQM', 'Daryl Hall, John Oates - Maneater (Lyrics)', 'GOD LYRICS', 273),
    c(
      'TFhjplnlBzo',
      'Daryl Hall & John Oates - Maneater (Remastered Audio) UHD 4K',
      'Happy Charlie',
      270,
    ),
  ],
  /** The Smiths - There Is a Light That Never Goes Out - 2011 Remaster */
  smiths: [
    c(
      'jC7ydeV62Ac',
      'There Is a Light That Never Goes Out (2011 Remaster)',
      'The Smiths - Topic',
      245,
    ),
    c(
      'siO6dkqidc4',
      'The Smiths - There Is A Light That Never Goes Out (Official Audio)',
      'The Smiths',
      245,
    ),
    c('hb0jH0ce1NQ', 'The Smiths - There Is A Light That Never Goes Out', 'The Smiths', 245),
    c(
      'UbmQ5uX0QX4',
      'The Smiths   There Is A Light That Never Goes Out   432Hz',
      'Music MTV - World',
      245,
    ),
    c(
      'aev1nt-5_9M',
      'There Is a Light That Never Goes Out (2008 Remaster)',
      'The Smiths - Topic',
      246,
    ),
    c(
      'RFTbeQ_O8U0',
      'There Is a Light That Never Goes Out - The Smiths - lyrics',
      'Lyric&Tradução',
      255,
    ),
    c(
      '56KEwU-IcVM',
      'Morrissey - There is a Light that Never Goes Out (Move Festival, Manchester 2004)',
      'NudeAvenger',
      253,
    ),
    c(
      'C6vsTkKPq8s',
      'The Smiths - There Is A Light That Never Goes Out (Normal People)',
      'Amey Surve',
      237,
    ),
    c(
      'D0kHXMK0sOA',
      'The Smiths - There Is a Light That Never Goes Out | Lyrics',
      'Rock Overdrive',
      244,
    ),
    c(
      'e2gUTLXdeBI',
      'The Smiths - There Is A Light That Never Goes Out (Live) [Official Audio]',
      'The Smiths',
      241,
    ),
  ],
  /** ANOTR, 54 Ultra - Talk To You (ft. 54 Ultra) */
  anotr: [
    c('ajUMhpotf8k', 'ANOTR ft. 54 Ultra - Talk To You [No Art]', 'ANOTR and No Art Music', 190),
    c(
      'aGAqCa2eWX4',
      'ANOTR ft. 54 Ultra - Talk To You (Extended Mix) [No Art]',
      'Alejandro Villa Sánchez',
      307,
    ),
    c(
      '2LDPHjXMOEM',
      'ANOTR, 54 Ultra - Talk To You (Official Lyric Video)',
      'ANOTR and No Art Music',
      302,
    ),
    c('_cbFLiMm2xY', 'ANOTR, 54 Ultra - Talk To You (Octavee remix)', 'Octavee', 216),
    c('LxIUchvq32s', 'Talk To You (Extended Mix)', 'ANOTR', 307),
    c('zjMIFS3BkW8', 'ANOTR ft. 54 Ultra - Talk To You (SWAV Edit)', 'f u j i .', 288),
    c(
      'W6V_xyyb7C4',
      'ANOTR ft. 54 Ultra - Talk 2 You ( TopDan, Grey Daniels & Robinson Remix )',
      'TopDan',
      375,
    ),
    c(
      'qEp8E-sxjOc',
      'ANOTR ft. 54 Ultra - Talk To You | 10 Hour Loop (Repeated & Extended)',
      'PLUX4',
      36117,
    ),
    c(
      '8MJ9qJPXJ2Y',
      'ANOTR ft. 54 Ultra - Talk to you (Strings Edit) - Live at Alexandra Palace 2026',
      'BEATFREAXX',
      398,
    ),
    c('5B0FTOxAOZg', 'ANOTR ft. 54 Ultra - Talk To You (Eli Brown Bootleg) [HQ]', 'sulexi1', 280),
  ],
  /** Dave, Tems - Raindance (feat. Tems) */
  raindance: [
    c('SOJpE1KMUbo', 'Dave - Raindance (ft. Tems)', 'Santan Dave and Tems', 221),
    c('bhoybya39QU', 'Dave, Tems - Raindance (Lyrics)', 'InvertOG', 220),
    c('t4yafKiE-5U', 'Dave ft. Tems – Raindance', 'New Jamz', 220),
    c('QkUPur9ZvoI', 'Dave - Raindance (feat. Tems)', '7Cakes', 208),
    c('UMZn_5Ispdo', 'Dave - Raindance (Lyrics) ft. Tems', 'FutureHype', 201),
    c(
      'wtaNoFygCyI',
      'Tems Brings Out Dave for “Raindance” — Full Performance at All Points East 2026',
      'Deeds',
      248,
    ),
    c(
      'r3W1bRISgJI',
      'Dave, Tems - Raindance (Soluka x De La Noise Afro House Remix)',
      'Afro House Mafia',
      262,
    ),
    c('A39vWVF_xNc', 'Dave, Tems - Raindance (feat. Tems) (Lyrics)', 'Novy Almy', 1397),
    c('yOR5LKfdytA', 'Dave - Raindance ft. Tems (Lyrics)', 'Rap City', 220),
    c('xpl-5dt9D3E', 'Raindance *best part* (Dave ft tems)', 'streamerclipss', 149),
  ],
  /** Irene Cara - Flashdance...What a Feeling - Radio Edit */
  flashdance: [
    c(
      'ILWSp0m9G2U',
      'Irene Cara  - Flashdance What A Feeling (Official Music Video)',
      'UnidiscMusic',
      200,
    ),
    c(
      'z20i7cM5BlY',
      'Irene Cara - Flashdance...What a Feeling - Radio Edit | Official Audio',
      'Top Music Archive',
      238,
    ),
    c(
      'A64KVUfo4ew',
      'Irene Cara - Flashdance What A Feeling (Remastered) [Audio HQ]',
      'GoldenMusic',
      233,
    ),
    c(
      '0TMoc959LCA',
      'Irene Cara - Flashdance ... What A Feeling (Radio-Edit) Geffen Records 1983',
      'DiscoSaturdayNightTV',
      244,
    ),
    c(
      '7uHZfjAjO7E',
      'Irene Cara - Flashdance...What A Feeling (Lyrics)',
      'Young Pilgrim Music',
      248,
    ),
    c('SxC2DFu0to0', 'Irene Cara - What A Feeling  (Radio Version)', 'Retro Musical', 221),
    c('miax0Jpe5mA', 'Flashdance • What a Feeling • Irene Cara', 'HD Film Tributes', 241),
    c(
      '6xdygxB7afU',
      'Irene Cara - Flashdance What A Feeling (Oskar 1984) HD',
      'shack of stories',
      219,
    ),
    c('fqzs4qWi1X4', 'Flashdance (What a Feeling)', 'Irene Cara', 234),
    c('R3W9zplEiV0', 'Flashdance - What A Feeling (S.Martin Remix 2019)', 'S.Martin Remix', 344),
  ],
  /** Earth, Wind & Fire - Let's Groove */
  groove: [
    c(
      'Lrle0x_DHBM',
      "Earth, Wind & Fire - Let's Groove (Official HD Video)",
      'Earth Wind & Fire',
      236,
    ),
    c(
      '8D4hcrkI2xU',
      "Earth, Wind & Fire - Let's Groove (Official Audio)",
      'Earth Wind & Fire',
      341,
    ),
    c(
      'wb4KBQvzm8s',
      "Earth, Wind & Fire ~ Let's Groove 1981 Disco Purrfection Version",
      'DJDiscoCat',
      471,
    ),
    c(
      'mLkP13qmQTY',
      "Earth, Wind & Fire - Let's Groove (Lyrics) let's groove tonight tiktok",
      'Dan Music',
      346,
    ),
    c(
      '-0w30UJ1rJA',
      "Earth, Wind & Fire - Let's Groove (Instrumental/Audio)",
      'Earth Wind & Fire',
      240,
    ),
    c('7qsziy16WXY', "Furina: Hu Tao, let's groove tonight and forever! 💃", 'Stormz67', 23),
    c('lhTXcUl44Sk', 'Earth, Wind & Fire - Lets groove', 'OLD TAPES', 394),
    c('vu8SQgtGcnU', "Ultimate Let's Groove Dance Collab!", 'm1s3n', 184),
    c('0Fw4ONNG3Hc', "Earth, Wind & Fire - Let's Groove (Lyrics)", 'Vibe Music', 340),
    c('5LBfGZQKLqw', "Let's Groove", 'Earth Wind & Fire', 211),
  ],
} satisfies Record<string, Candidate[]>

const RICK = parseSearchResults(RECORDED_SEARCH)
const NEVER_GONNA = {
  title: 'Never Gonna Give You Up',
  artists: ['Rick Astley'],
  durationSec: 213.573,
}

describe('searchQuery', () => {
  it.each([
    [
      { title: 'Never Gonna Give You Up', artists: ['Rick Astley'] },
      'Rick Astley - Never Gonna Give You Up',
    ],
    [
      { title: 'expectations (feat. Chappell Roan)', artists: ['Olivia Rodrigo', 'Chappell Roan'] },
      'Olivia Rodrigo, Chappell Roan - expectations (feat. Chappell Roan)',
    ],
    [{ title: 'Nicole Kidman', artists: ['ADÉLA'] }, 'ADÉLA - Nicole Kidman'],
    [{ title: 'Untitled', artists: [] }, 'Untitled'],
    [{ title: '', artists: ['Only Artist'] }, 'Only Artist'],
  ])('names %j as uploads are named: artists - title', (track, query) => {
    expect(searchQuery(track)).toBe(query)
  })

  it('turns control characters into one space and trims, so the query stays one line', () => {
    expect(searchQuery({ title: 'Song\r\nPart\u0000\u0007Two\u007f\t', artists: ['A\nB'] })).toBe(
      'A B - Song Part Two',
    )
  })

  it('replaces a lone surrogate, which no argv can carry', () => {
    expect(searchQuery({ title: 'Bad \ud800 Half', artists: ['X'] })).toBe('X - Bad � Half')
  })

  it(`cuts a long query at ${MAX_QUERY_LENGTH} code points, never inside an emoji or before a space`, () => {
    const long = searchQuery({ title: 'word '.repeat(100), artists: ['A'] })
    expect(Array.from(long).length).toBeLessThanOrEqual(MAX_QUERY_LENGTH)
    expect(long).toBe(long.trimEnd())
    expect(long.startsWith('A - word word')).toBe(true)
    // 'A - ' and 195 letters leave room for one emoji: it is kept whole, the next one goes.
    const emoji = searchQuery({ title: `${'x'.repeat(195)}🎵🎵`, artists: ['A'] })
    expect(emoji.isWellFormed()).toBe(true)
    expect(emoji).toBe(`A - ${'x'.repeat(195)}🎵`)
    expect(Array.from(emoji)).toHaveLength(MAX_QUERY_LENGTH)
  })

  it('is empty for a track with no names at all (the matcher then answers no_match)', () => {
    expect(searchQuery({ title: ' \n ', artists: [] })).toBe('')
  })
})

describe('parseSearchResults', () => {
  it('reads the recorded search: every video with its channel and length, in YouTube’s order', () => {
    expect(RICK).toHaveLength(SEARCH_RESULTS)
    expect(RICK.slice(0, 2)).toStrictEqual([
      {
        id: 'dQw4w9WgXcQ',
        title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
        uploader: 'Rick Astley',
        durationSec: 214,
      },
      {
        id: 'MOcQaR7_Wro',
        title: 'Never Gonna Give You Up - Rick Astley (Lyrics)',
        uploader: 'Invited Kingdom',
        durationSec: 214,
      },
    ])
    expect(RICK.at(-1)).toMatchObject({ id: 'nsCIeklgp1M', durationSec: 560 })
  })

  const entry = (fields: Record<string, unknown> = {}) => ({
    _type: 'url',
    ie_key: 'Youtube',
    id: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'A Song',
    channel: 'A Channel',
    uploader: 'An Uploader',
    duration: 200,
    live_status: null,
    ...fields,
  })
  const parse = (...entries: unknown[]) => parseSearchResults({ _type: 'playlist', entries })

  it.each([
    ['a short', { url: 'https://www.youtube.com/shorts/BGQWPY4IigY' }],
    ['a live stream', { live_status: 'is_live' }],
    ['an upcoming stream', { live_status: 'is_upcoming' }],
    ['no id', { id: undefined }],
    ['a channel’s id', { id: 'UCuAXFkgsw1L7xaCfnd5JJOw' }],
    ['an id with other characters', { id: 'dQw4w9WgXc/' }],
    ['no title', { title: undefined }],
    ['an empty title', { title: '   ' }],
  ])('skips %s', (_label, fields) => {
    expect(parse(entry(fields), entry({ id: 'LLFhKaqnWwk' })).map((one) => one.id)).toEqual([
      'LLFhKaqnWwk',
    ])
  })

  it('keeps a past live stream and a video without a length, which pickMatch then passes over', () => {
    expect(parse(entry({ live_status: 'was_live', duration: undefined }))).toStrictEqual([
      { id: 'dQw4w9WgXcQ', title: 'A Song', uploader: 'A Channel' },
    ])
  })

  it('names the channel, else the uploader, and reads odd fields as missing', () => {
    expect(
      parse(
        entry({ channel: null }),
        entry({ id: 'LLFhKaqnWwk', channel: undefined, uploader: undefined, duration: '200' }),
        entry({ id: '3BFTio5296w', duration: -1, title: '  Trimmed  ' }),
      ),
    ).toStrictEqual([
      { id: 'dQw4w9WgXcQ', title: 'A Song', uploader: 'An Uploader', durationSec: 200 },
      { id: 'LLFhKaqnWwk', title: 'A Song' },
      { id: '3BFTio5296w', title: 'Trimmed', uploader: 'A Channel' },
    ])
  })

  it.each([
    ['null', null],
    ['a string', 'ytsearch10:x'],
    ['no entries', { _type: 'playlist' }],
    ['entries that are no list', { entries: { 0: entry() } }],
    ['null entries', { entries: [null, 7, 'x'] }],
  ])('answers no candidates for %s', (_label, json) => {
    expect(parseSearchResults(json)).toEqual([])
  })
})

describe('pickMatch', () => {
  const PATIENT_ZERO = { title: 'Patient Zero', artists: ['Taylor Swift'], durationSec: 225.881 }
  const NICOLE_KIDMAN = { title: 'Nicole Kidman', artists: ['ADÉLA'], durationSec: 181.27 }
  const EXPECTATIONS = {
    title: 'expectations (feat. Chappell Roan)',
    artists: ['Olivia Rodrigo', 'Chappell Roan'],
    durationSec: 223.935,
  }
  const MANEATER = { title: 'Maneater', artists: ['Daryl Hall & John Oates'], durationSec: 273.2 }
  const THE_SMITHS = {
    title: 'There Is a Light That Never Goes Out - 2011 Remaster',
    artists: ['The Smiths'],
    durationSec: 244.586,
  }
  const TALK_TO_YOU = {
    title: 'Talk To You (ft. 54 Ultra)',
    artists: ['ANOTR', '54 Ultra'],
    durationSec: 191.1,
  }
  const RAINDANCE = {
    title: 'Raindance (feat. Tems)',
    artists: ['Dave', 'Tems'],
    durationSec: 219.7,
  }
  const FLASHDANCE = {
    title: 'Flashdance...What a Feeling - Radio Edit',
    artists: ['Irene Cara'],
    durationSec: 237.1,
  }
  const LETS_GROOVE = { title: "Let's Groove", artists: ['Earth, Wind & Fire'], durationSec: 339 }

  const without = (list: readonly Candidate[], ...ids: string[]) =>
    list.filter((candidate) => !ids.includes(candidate.id))

  it.each([
    [
      'the official video, YouTube’s first result, among its re-uploads',
      NEVER_GONNA,
      RICK,
      'dQw4w9WgXcQ',
    ],
    [
      'the 2022 remaster (214 s) from the artist’s channel once the video is gone',
      NEVER_GONNA,
      without(RICK, 'dQw4w9WgXcQ', 'LLFhKaqnWwk'),
      '3BFTio5296w',
    ],
    [
      'the artist’s own upload over closer "(Lyrics)" re-uploads, the name’s accent ignored',
      NICOLE_KIDMAN,
      LIVE.adela,
      'IXA6bQsVNjs',
    ],
    [
      'the artist’s lyric video for a "feat." title, over the music video (69 s longer) and reactions',
      EXPECTATIONS,
      LIVE.expectations,
      'SmzLX_weRMc',
    ],
    ['the closest of the duo’s own uploads, & and all', MANEATER, LIVE.maneater, 'Scd35orIrks'],
    [
      'the Topic channel’s "(2011 Remaster)" for a "- 2011 Remaster" title, not a live take',
      THE_SMITHS,
      LIVE.smiths,
      'jC7ydeV62Ac',
    ],
    [
      'the radio edit, not the extended mixes, edits, remixes or the 10-hour loop',
      TALK_TO_YOU,
      LIVE.anotr,
      'ajUMhpotf8k',
    ],
    [
      'the artists\' shared channel\'s "ft." upload for a "(feat. …)" title',
      RAINDANCE,
      LIVE.raindance,
      'SOJpE1KMUbo',
    ],
    [
      '"- Radio Edit | Official Audio" for a "- Radio Edit" title',
      FLASHDANCE,
      LIVE.flashdance,
      'z20i7cM5BlY',
    ],
    [
      'the official audio (2 s off), not the instrumental or the shorter video',
      LETS_GROOVE,
      LIVE.groove,
      '8D4hcrkI2xU',
    ],
  ] as const)('picks %s', (_label, track, candidates, id) => {
    expect(pickMatch(track, candidates)?.candidate.id).toBe(id)
  })

  it('never picks another version of the song, whatever its length', () => {
    const picked = pickMatch(PATIENT_ZERO, LIVE.patient)
    expect(picked?.candidate.title).toMatch(
      /^Taylor Swift - Patient Zero \((Official )?Lyrics?( Video)?\)$/,
    )
    expect(
      Math.abs((picked?.candidate.durationSec ?? 0) - PATIENT_ZERO.durationSec),
    ).toBeLessThanOrEqual(MAX_DURATION_DELTA_SEC)
  })

  // One result at a time: what each check alone lets through.
  it.each([
    [
      'a piano version',
      PATIENT_ZERO,
      c('pianoVers01', 'Taylor Swift - Patient Zero (Piano Version)', 'Taylor Swift', 226),
    ],
    [
      'a reaction of the right length',
      EXPECTATIONS,
      c('reaction001', 'Olivia Rodrigo - expectations | Reaction', 'Fans', 224),
    ],
    [
      '"reacts" in the title',
      EXPECTATIONS,
      c('reacts00001', 'Producer Reacts to Olivia Rodrigo - expectations', 'Blake', 224),
    ],
    [
      'a 1-hour loop of the right length (a cut)',
      NEVER_GONNA,
      c('loop0000001', 'Rick Astley - Never Gonna Give You Up 1 Hour Loop', 'Loops', 214),
    ],
    [
      'the 10-hour loop',
      TALK_TO_YOU,
      c(
        'qEp8E-sxjOc',
        'ANOTR ft. 54 Ultra - Talk To You | 10 Hour Loop (Repeated & Extended)',
        'PLUX4',
        36117,
      ),
    ],
    ['an extended mix', TALK_TO_YOU, c('LxIUchvq32s', 'Talk To You (Extended Mix)', 'ANOTR', 307)],
    [
      'a live take of the right length',
      THE_SMITHS,
      c(
        'e2gUTLXdeBI',
        'The Smiths - There Is A Light That Never Goes Out (Live) [Official Audio]',
        'The Smiths',
        245,
      ),
    ],
    [
      'an instrumental of the right length',
      LETS_GROOVE,
      c(
        '-0w30UJ1rJA',
        "Earth, Wind & Fire - Let's Groove (Instrumental/Audio)",
        'Earth Wind & Fire',
        339,
      ),
    ],
    [
      'a sped up upload',
      NEVER_GONNA,
      c('spedUp00001', 'Rick Astley - Never Gonna Give You Up (Sped Up)', 'Speedy', 214),
    ],
    [
      'a cover by someone else',
      NEVER_GONNA,
      c('cover000001', 'Never Gonna Give You Up (Cover)', 'Rick Astley Fans', 214),
    ],
    [
      'the music video, 87 s longer',
      PATIENT_ZERO,
      c('mw3kSNIxjqo', 'Taylor Swift - Patient Zero (Official Music Video)', 'Taylor Swift', 313),
    ],
    [
      `a result ${MAX_DURATION_DELTA_SEC + 1} s off`,
      NEVER_GONNA,
      c('off00000001', 'Rick Astley - Never Gonna Give You Up', 'Rick Astley', 220),
    ],
    [
      'a result without a length',
      NEVER_GONNA,
      {
        id: 'nolength001',
        title: 'Rick Astley - Never Gonna Give You Up',
        uploader: 'Rick Astley',
      },
    ],
    [
      'another song by the artist',
      PATIENT_ZERO,
      c('9FHuWije2VE', 'Pink Clouding', 'Taylor Swift', 226),
    ],
    [
      'part of the title only',
      PATIENT_ZERO,
      c('partial0001', 'Taylor Swift - Patient', 'Taylor Swift', 226),
    ],
    [
      'the song by an artist it doesn’t name',
      PATIENT_ZERO,
      c('someband001', 'Some Band - Patient Zero', 'Some Band', 226),
    ],
    [
      'an artist named only inside a word',
      MANEATER,
      c('inword00001', 'Maneater', 'DarylHallAndJohnOatesFan', 273),
    ],
  ])('rejects %s', (_label, track, candidate) => {
    expect(pickMatch(track, [candidate])).toBeUndefined()
  })

  it.each([
    [
      'its own version word',
      FLASHDANCE,
      c('radioedit01', 'Irene Cara - Flashdance What a Feeling (Radio Edit)', 'Archive', 237),
    ],
    [
      'an extended mix when the Spotify title is one, told apart by its length',
      { title: 'Talk To You (Extended Mix)', artists: ['ANOTR', '54 Ultra'], durationSec: 307.2 },
      c('LxIUchvq32s', 'Talk To You (Extended Mix)', 'ANOTR', 307),
    ],
    [
      'the artist only in the channel name',
      MANEATER,
      c('oqy2N1jM2tU', 'Maneater', 'Daryl Hall & John Oates', 272),
    ],
    [
      '"and" for "&"',
      MANEATER,
      c('andandand01', 'Daryl Hall and John Oates - Maneater', 'Oldies', 273),
    ],
    [
      'the second artist only',
      EXPECTATIONS,
      c('second00001', 'Chappell Roan - expectations', 'Uploads', 224),
    ],
    [
      'an accent the upload leaves out',
      NICOLE_KIDMAN,
      c('noaccent001', 'Adela - Nicole Kidman', 'Music', 181),
    ],
    [
      'a Topic channel',
      NEVER_GONNA,
      c('topic000001', 'Never Gonna Give You Up', 'Rick Astley - Topic', 213),
    ],
    [
      'the remaster note left out',
      THE_SMITHS,
      c('hb0jH0ce1NQ', 'The Smiths - There Is A Light That Never Goes Out', 'The Smiths', 245),
    ],
    [
      '"(Lyrics)"',
      PATIENT_ZERO,
      c('59o4m222aVw', 'Taylor Swift - Patient Zero (Lyrics)', 'Chill Only', 226),
    ],
    [
      `a length exactly ${MAX_DURATION_DELTA_SEC} s off`,
      { ...NEVER_GONNA, durationSec: 209 },
      c('edge0000001', 'Rick Astley - Never Gonna Give You Up', 'X', 214),
    ],
  ])('accepts %s', (_label, track, candidate) => {
    expect(pickMatch(track, [candidate])?.candidate).toBe(candidate)
  })

  it('prefers, all else equal: a closer length, then the artist’s channel, official audio, no lyrics', () => {
    const base = c('base0000001', 'Rick Astley - Never Gonna Give You Up', 'Someone', 214)
    const score = (candidate: Candidate) => pickMatch(NEVER_GONNA, [candidate])?.score ?? -1
    expect(score(base)).toBeGreaterThan(score({ ...base, durationSec: 216 }))
    expect(score({ ...base, uploader: 'Rick Astley' })).toBeGreaterThan(score(base))
    expect(score({ ...base, uploader: 'Rick Astley - Topic' })).toBeGreaterThan(score(base))
    expect(score({ ...base, title: `${base.title} (Official Audio)` })).toBeGreaterThan(score(base))
    expect(score({ ...base, title: `${base.title} (Lyrics)` })).toBeLessThan(score(base))
    // Ties go to YouTube's order.
    const twin = { ...base, id: 'twin0000001' }
    expect(pickMatch(NEVER_GONNA, [base, twin])?.candidate).toBe(base)
    expect(pickMatch(NEVER_GONNA, [twin, base])?.candidate).toBe(twin)
  })

  it('weighs a lyrics re-upload a second closer below the artist’s own upload', () => {
    const own = c('IXA6bQsVNjs', 'Nicole Kidman', 'ADÉLA', 182)
    const lyrics = c('8i8kpxkzUZk', 'ADÉLA - Nicole Kidman (Lyrics)', 'Lost Panda', 181)
    expect(pickMatch(NICOLE_KIDMAN, [lyrics, own])?.candidate).toBe(own)
  })

  it('picks nothing for a track without a length: it can’t tell versions apart', () => {
    const { durationSec: _none, ...noLength } = NEVER_GONNA
    expect(pickMatch(noLength, RICK)).toBeUndefined()
  })

  it('picks nothing from no results, or when none passes', () => {
    expect(pickMatch(NEVER_GONNA, [])).toBeUndefined()
    expect(pickMatch(PATIENT_ZERO, RICK)).toBeUndefined()
  })
})

describe('rankMatches', () => {
  const NEVER_GONNA_TRACK = {
    title: 'Never Gonna Give You Up',
    artists: ['Rick Astley'],
    durationSec: 213.573,
  }

  it('lists every result that passes, best first, which pickMatch takes the first of', () => {
    const ranked = rankMatches(NEVER_GONNA_TRACK, RICK)
    expect(ranked.map((match) => match.candidate.id)).toEqual([
      'dQw4w9WgXcQ',
      'LLFhKaqnWwk',
      '3BFTio5296w',
      'RrESvSRNpeo',
      '5SZYz7lZRRI',
      'MOcQaR7_Wro',
      'LQ4w9xiHkrY',
      'ctlZNgedZ28',
    ])
    const scores = ranked.map((match) => match.score)
    expect(scores).toEqual(scores.toSorted((a, b) => b - a))
    expect(pickMatch(NEVER_GONNA_TRACK, RICK)).toEqual(ranked[0])
  })

  it('keeps YouTube’s order between equal scores', () => {
    // 0.5 s off at rank 1, and 0.25 s off at rank 2: 4 points a second, 1 a rank, the same score.
    const track = { ...NEVER_GONNA_TRACK, durationSec: 213.5 }
    const one = c('first000001', 'Rick Astley - Never Gonna Give You Up', 'Someone', 214)
    const two = { ...one, id: 'second00002', durationSec: 213.75 }
    const ranked = rankMatches(track, [one, two])
    expect(ranked[0]?.score).toBe(ranked[1]?.score)
    expect(ranked.map((match) => match.candidate)).toEqual([one, two])
  })

  it('is empty without a length or a passing result', () => {
    const { durationSec: _none, ...noLength } = NEVER_GONNA_TRACK
    expect(rankMatches(noLength, RICK)).toEqual([])
    expect(rankMatches({ ...NEVER_GONNA_TRACK, title: 'Patient Zero' }, RICK)).toEqual([])
  })
})

describe('pickMatch: the Spotify title’s own version', () => {
  const at = (title: string, artists: string[], durationSec = 200) => ({
    title,
    artists,
    durationSec,
  })

  it.each([
    [
      'an instrumental for "- Instrumental"',
      at('Losing It - Instrumental', ['FISHER']),
      c('instrument1', 'FISHER - Losing It (Instrumental)', 'FISHER', 200),
    ],
    [
      'an acoustic take for "- Acoustic"',
      at('Song - Acoustic', ['Artist']),
      c('acoustic001', 'Artist - Song (Acoustic)', 'Artist', 201),
    ],
    [
      'an "(Acoustic Version)" upload for "- Acoustic"',
      at('Song - Acoustic', ['Artist']),
      c('acoustic002', 'Artist - Song (Acoustic Version)', 'Artist', 201),
    ],
    [
      'the remix by the remixer the title names',
      at('Song - Remixer A Remix', ['Artist']),
      c('remixerA001', 'Artist - Song (Remixer A Remix)', 'Remixer A', 200),
    ],
    [
      'a plain upload for "- Radio Edit" (edits are told apart by length)',
      at('Song - Radio Edit', ['Artist']),
      c('plainsong01', 'Artist - Song', 'Artist', 200),
    ],
    [
      'LIVE, whose name is a version word',
      at('Lightning Crashes', ['LIVE'], 325.2),
      c('lightning01', 'LIVE - Lightning Crashes (Official Music Video)', 'LIVE', 326),
    ],
    [
      'Orchestral Manoeuvres In The Dark, whose name is a version word',
      at('Enola Gay', ['Orchestral Manoeuvres In The Dark'], 213.4),
      c('enolagay001', 'Orchestral Manoeuvres In The Dark - Enola Gay', 'OMD', 213),
    ],
    [
      'Session Victim, whose name is a version word',
      at('Never Let Me Go', ['Session Victim'], 400),
      c('sessionvic1', 'Session Victim - Never Let Me Go', 'Delusions of Grandeur', 401),
    ],
    [
      'a soundtrack note worded another way',
      at('Sexy Magic (from GTAVI: The Album)', ['Some Artist'], 190),
      c(
        'gtavi000001',
        'Some Artist - Sexy Magic (From Grand Theft Auto VI: The Album)',
        'Some Artist',
        190,
      ),
    ],
  ])('accepts %s', (_label, track, candidate) => {
    expect(pickMatch(track, [candidate])?.candidate).toBe(candidate)
  })

  it.each([
    [
      'only a vocal upload for "- Instrumental"',
      at('Losing It - Instrumental', ['FISHER']),
      c('vocal000001', 'FISHER - Losing It', 'FISHER', 200),
    ],
    [
      'the studio upload for "- Acoustic"',
      at('Song - Acoustic', ['Artist']),
      c('studio00001', 'Artist - Song (Official Audio)', 'Artist', 200),
    ],
    [
      'the original for a remix',
      at('Song - Remixer A Remix', ['Artist']),
      c('original001', 'Artist - Song', 'Artist', 200),
    ],
    [
      'another remixer’s remix ("a" is a name word, not a filler)',
      at('Song - Remixer A Remix', ['Artist']),
      c('remixerB001', 'Artist - Song (Remixer B Remix)', 'Remixer B', 200),
    ],
    [
      'a live take of a band that isn’t LIVE',
      at('Lightning Crashes', ['Somebody Else'], 325),
      c('livetake001', 'Somebody Else - Lightning Crashes (Live)', 'Somebody Else', 325),
    ],
  ])('rejects %s', (_label, track, candidate) => {
    expect(pickMatch(track, [candidate])).toBeUndefined()
  })

  it('picks the named remixer’s upload over another remix 1 s closer', () => {
    const track = at('Song - Remixer A Remix', ['Artist'], 200)
    const other = c('remixerB001', 'Artist - Song (Remixer B Remix)', 'Remixer B', 200)
    const named = c('remixerA001', 'Artist - Song (Remixer A Remix)', 'Remixer A', 201)
    expect(pickMatch(track, [other, named])?.candidate).toBe(named)
  })
})
