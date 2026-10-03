import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { CollectionEntry } from './collection.ts'
import {
  type Batch,
  BatchSchema,
  type BulkJobsResponse,
  BulkJobsResponseSchema,
  type CancelJobsRequest,
  CancelJobsRequestSchema,
  type ClearJobsRequest,
  ClearJobsRequestSchema,
  type CreateDownloadsResponse,
  CreateDownloadsResponseSchema,
  DEFAULT_FILENAME_TEMPLATE,
  type DownloadFormat,
  DownloadFormatSchema,
  type DownloadOptions,
  DownloadOptionsSchema,
  type DownloadRequest,
  DownloadRequestSchema,
  type DownloadsSnapshot,
  DownloadsSnapshotSchema,
  FILENAME_PLACEHOLDERS,
  type FilenamePlaceholder,
  FilenameTemplateSchema,
  filenameTemplateProblem,
  isRetryableError,
  isTerminalStatus,
  type Job,
  type JobOutput,
  JobOutputSchema,
  type JobProgress,
  JobProgressSchema,
  JobSchema,
  type JobScope,
  JobScopeSchema,
  type JobStatus,
  JobStatusSchema,
  MAX_BATCH_LABEL_LENGTH,
  MAX_DOWNLOAD_ITEMS,
  MAX_FILENAME_TEMPLATE_LENGTH,
  MAX_SUBFOLDER_LENGTH,
  MAX_TRACK_TEXT_LENGTH,
  type PauseCode,
  PauseCodeSchema,
  type PlatformQueueState,
  PlatformQueueStateSchema,
  type QueueState,
  QueueStateSchema,
  type RetryableStatus,
  RetryableStatusSchema,
  type RetryJobsRequest,
  RetryJobsRequestSchema,
  TERMINAL_JOB_STATUSES,
  type TrackRef,
  TrackRefSchema,
  templatePlaceholders,
} from './download.ts'
import { type ErrorCode, ErrorCodeSchema, type ErrorInfo } from './errors.ts'
import type { FolderPath } from './folder.ts'
import type { Platform } from './platform.ts'
import { MAX_COLLECTION_ENTRIES } from './resolve.ts'
import {
  issuePaths,
  jobsByStatus,
  nonHttpUrls,
  type OptionalKeys,
  soundcloudRowRef,
  testBatch,
  testUuid,
  without,
  youtubeRef,
} from './test-helpers.ts'
import {
  type AudioSource,
  type Availability,
  MAX_ID_LENGTH,
  type Track,
  type UnavailableReason,
  UnavailableReasonSchema,
} from './track.ts'
import { MAX_URL_LENGTH } from './url.ts'

describe('DownloadFormatSchema', () => {
  it.each(['mp3', 'm4a', 'aiff', 'wav', 'flac', 'original'])('accepts %j', (format) => {
    expect(DownloadFormatSchema.parse(format)).toBe(format)
  })

  it.each(['opus', 'webm'])(
    'offers no %j target: Opus/WebM files only come from original',
    (format) => {
      expect(DownloadFormatSchema.safeParse(format).success).toBe(false)
    },
  )

  it.each(['MP3', 'aif', 'ogg', 'mp3-320', ''])('rejects %j', (format) => {
    expect(DownloadFormatSchema.safeParse(format).success).toBe(false)
  })

  it('is exactly the six formats of the settings screen', () => {
    expectTypeOf<DownloadFormat>().toEqualTypeOf<
      'mp3' | 'm4a' | 'aiff' | 'wav' | 'flac' | 'original'
    >()
  })
})

describe('templatePlaceholders', () => {
  it('lists the placeholders in template order, repeats included', () => {
    expect(templatePlaceholders('{year} - {artist} - {title} ({year})')).toEqual([
      'year',
      'artist',
      'title',
      'year',
    ])
  })

  it('includes unknown and empty names, so callers can report them', () => {
    expect(templatePlaceholders('{artist} {nope} {} {TITLE}')).toEqual([
      'artist',
      'nope',
      '',
      'TITLE',
    ])
  })

  it('reads the innermost pair of doubled braces', () => {
    expect(templatePlaceholders('{{title}}')).toEqual(['title'])
  })

  it.each([
    ['plain text', 'My Track'],
    ['an unclosed placeholder', '{title'],
  ])('finds no placeholder in %s', (_label, template) => {
    expect(templatePlaceholders(template)).toEqual([])
  })
})

const validTemplates = [
  DEFAULT_FILENAME_TEMPLATE,
  '{title}',
  '{id}',
  '{platform}-{id}',
  '{artist} - {title} ({year})',
  '{year} - {artist} - {title}',
  '{uploader} - {title} [{album}]',
  '{title}{title}',
  'Set – {title}',
  FILENAME_PLACEHOLDERS.map((name) => `{${name}}`).join(' '),
]

/** Templates the settings form must refuse, with what the message has to say. */
const invalidTemplates = [
  ['names neither {title} nor {id}', '{artist}', /\{title\} or \{id\}/],
  ['is only literal text', 'My Track', /\{title\} or \{id\}/],
  ['has an unknown placeholder', '{artist} - {name}', /^Unknown placeholder \{name\}$/],
  ['spells a placeholder in capitals', '{Title}', /Unknown placeholder \{Title\}/],
  ['pads a placeholder name with spaces', '{ title }', /Unknown placeholder \{ title \}/],
  ['has an empty placeholder', '{title} {}', /Unknown placeholder \{\}/],
  ['opens a brace it never closes', '{title', /unmatched brace/],
  ['closes a brace it never opened', 'title}', /unmatched brace/],
  ['doubles the braces', '{{title}}', /unmatched brace/],
  ['has the braces backwards', '}{title}{', /unmatched brace/],
  ['contains a slash', '{artist}/{title}', /remove \/ and \\/],
  ['contains a backslash', '{artist}\\{title}', /remove \/ and \\/],
  ['contains NUL', '{title}\u0000', /control character/],
  ['contains a newline', '{artist}\n{title}', /control character/],
  ['contains a tab', '{artist}\t{title}', /control character/],
  ['contains DEL', '{title}\u007f', /control character/],
] as const

describe('filenameTemplateProblem', () => {
  it.each(validTemplates)('accepts %j', (template) => {
    expect(filenameTemplateProblem(template)).toBeUndefined()
  })

  it.each(invalidTemplates)('rejects a template that %s', (_label, template, message) => {
    expect(filenameTemplateProblem(template)).toMatch(message)
  })

  it.each(FILENAME_PLACEHOLDERS.filter((name) => name !== 'title' && name !== 'id'))(
    'rejects {%s} alone: two tracks would get the same name',
    (name) => {
      expect(filenameTemplateProblem(`{${name}}`)).toMatch(/\{title\} or \{id\}/)
    },
  )

  it('names a mistyped placeholder before asking for {title}', () => {
    expect(filenameTemplateProblem('{artist} - {titel}')).toBe('Unknown placeholder {titel}')
  })
})

describe('FilenameTemplateSchema', () => {
  it.each(validTemplates)('parses %j unchanged', (template) => {
    expect(FilenameTemplateSchema.parse(template)).toBe(template)
  })

  it.each(invalidTemplates)(
    'reports a template that %s at the root, with the problem as the message',
    (_label, template) => {
      const result = FilenameTemplateSchema.safeParse(template)
      expect(result.success).toBe(false)
      expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        { path: [], message: filenameTemplateProblem(template) },
      ])
    },
  )

  it('rejects an empty template', () => {
    expect(FilenameTemplateSchema.safeParse('').success).toBe(false)
  })

  it('accepts MAX_FILENAME_TEMPLATE_LENGTH characters and rejects one more', () => {
    const longest = `{title}${'a'.repeat(MAX_FILENAME_TEMPLATE_LENGTH - '{title}'.length)}`
    expect(issuePaths(FilenameTemplateSchema, longest)).toEqual([])
    expect(issuePaths(FilenameTemplateSchema, `${longest}a`)).toEqual([[]])
  })

  it('defaults to {artist} - {title}, which is valid', () => {
    expect(DEFAULT_FILENAME_TEMPLATE).toBe('{artist} - {title}')
    expect(filenameTemplateProblem(DEFAULT_FILENAME_TEMPLATE)).toBeUndefined()
  })

  it('names exactly the documented placeholders', () => {
    expectTypeOf<FilenamePlaceholder>().toEqualTypeOf<
      'artist' | 'title' | 'album' | 'year' | 'uploader' | 'id' | 'platform'
    >()
  })
})

/** A SoundCloud Go+ track the review screen marked unavailable: it fails at enqueue. */
const previewRef = {
  platform: 'soundcloud',
  id: '1234567891',
  url: 'https://soundcloud.com/some-label/go-plus-exclusive',
  title: 'Some Label - Go+ Exclusive',
  uploader: 'Some Label',
  durationSec: 30,
  availability: 'unavailable',
  unavailableReason: 'preview_only',
} satisfies TrackRef

/** Every field set, so omitting any one of them is a real change. */
const fullRef = {
  ...youtubeRef,
  availability: 'unavailable',
  unavailableReason: 'geo_blocked',
} satisfies TrackRef

const trackRefRequiredFields = ['platform', 'id', 'url'] as const
const trackRefOptionalFields = [
  'title',
  'artist',
  'uploader',
  'durationSec',
  'thumbnailUrl',
  'availability',
  'unavailableReason',
] as const
const trackRefTextFields = ['title', 'artist', 'uploader'] as const
const trackRefUrlFields = ['url', 'thumbnailUrl'] as const

describe('TrackRefSchema', () => {
  it.each([
    ['a full YouTube track', youtubeRef],
    ['a bare SoundCloud set row with an API URL', soundcloudRowRef],
    ['a SoundCloud preview-only track', previewRef],
    ['a ref with every field', fullRef],
    [
      'a SoundCloud user-page row with only a title',
      {
        platform: 'soundcloud',
        id: '1234567892',
        url: 'https://soundcloud.com/some-artist/warehouse-dub',
        title: 'Warehouse Dub',
      },
    ],
  ])('parses %s unchanged', (_label, ref) => {
    expect(TrackRefSchema.parse(ref)).toStrictEqual(ref)
  })

  it.each(trackRefRequiredFields)('requires %s', (field) => {
    expect(issuePaths(TrackRefSchema, without(youtubeRef, field))).toEqual([[field]])
  })

  it.each(trackRefOptionalFields)('allows %s to be omitted', (field) => {
    expect(issuePaths(TrackRefSchema, without(fullRef, field))).toEqual([])
  })

  it.each(trackRefOptionalFields)('rejects null for %s', (field) => {
    expect(issuePaths(TrackRefSchema, { ...fullRef, [field]: null })).toEqual([[field]])
  })

  it('takes a resolved Track as it is, dropping its source stream', () => {
    const track = { ...youtubeRef, source: { codec: 'opus', bitrateKbps: 135.817 } } satisfies Track
    expect(TrackRefSchema.parse(track)).toStrictEqual(youtubeRef)
  })

  it('takes a collection row as it is, dropping its partial flag', () => {
    const row = {
      ...soundcloudRowRef,
      availability: 'unknown',
      partial: true,
    } satisfies CollectionEntry
    expect(TrackRefSchema.parse(row)).toStrictEqual({
      ...soundcloudRowRef,
      availability: 'unknown',
    })
  })

  it.each(trackRefTextFields)(
    'accepts a %s of MAX_TRACK_TEXT_LENGTH characters and rejects a longer one',
    (field) => {
      const text = 'a'.repeat(MAX_TRACK_TEXT_LENGTH)
      expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: text })).toEqual([])
      expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: `${text}a` })).toEqual([[field]])
    },
  )

  it.each(trackRefTextFields)('rejects an empty %s (omit it instead)', (field) => {
    expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: '' })).toEqual([[field]])
  })

  it.each(trackRefUrlFields.flatMap((field) => nonHttpUrls.map((url) => ({ field, url }))))(
    'rejects $url as $field',
    ({ field, url }) => {
      expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: url })).toEqual([[field]])
    },
  )

  it.each(trackRefUrlFields)(
    'accepts a %s of MAX_URL_LENGTH characters and rejects a longer one',
    (field) => {
      const base = 'https://i1.sndcdn.com/'
      const url = base + 'a'.repeat(MAX_URL_LENGTH - base.length)
      expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: url })).toEqual([])
      expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: `${url}a` })).toEqual([[field]])
    },
  )

  it('accepts an id of MAX_ID_LENGTH characters', () => {
    const id = 'a'.repeat(MAX_ID_LENGTH)
    expect(issuePaths(TrackRefSchema, { ...soundcloudRowRef, id })).toEqual([])
  })

  it.each([
    ['an empty id', 'id', ''],
    ['a numeric id', 'id', 1234567893],
    ['an id longer than MAX_ID_LENGTH', 'id', 'a'.repeat(MAX_ID_LENGTH + 1)],
    ['an out-of-scope platform', 'platform', 'spotify'],
    ['an error code as the availability', 'availability', 'private'],
    ['a code that does not explain unavailability', 'unavailableReason', 'network'],
    ['a negative duration', 'durationSec', -1],
    ['a NaN duration', 'durationSec', Number.NaN],
  ])('rejects %s', (_label, field, value) => {
    expect(issuePaths(TrackRefSchema, { ...youtubeRef, [field]: value })).toEqual([[field]])
  })

  it('makes exactly platform, id and url required', () => {
    expectTypeOf<OptionalKeys<TrackRef>>().toEqualTypeOf<(typeof trackRefOptionalFields)[number]>()
    expectTypeOf<Exclude<keyof TrackRef, OptionalKeys<TrackRef>>>().toEqualTypeOf<
      (typeof trackRefRequiredFields)[number]
    >()
  })

  it('types fields with the shared enums', () => {
    expectTypeOf<TrackRef['platform']>().toEqualTypeOf<Platform>()
    expectTypeOf<TrackRef['availability']>().toEqualTypeOf<Availability | undefined>()
    expectTypeOf<TrackRef['unavailableReason']>().toEqualTypeOf<UnavailableReason | undefined>()
  })

  it('lets the web send a Track or a collection row without mapping it', () => {
    expectTypeOf<Track>().toExtend<z.input<typeof TrackRefSchema>>()
    expectTypeOf<CollectionEntry>().toExtend<z.input<typeof TrackRefSchema>>()
    expectTypeOf<z.input<typeof TrackRefSchema>>().toEqualTypeOf<TrackRef>()
  })
})

const options = {
  format: 'mp3',
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  embedArtwork: true,
  sourceUrlComment: true,
} satisfies DownloadOptions

const playlistOptions = {
  format: 'aiff',
  filenameTemplate: '{artist} - {title} ({year})',
  embedArtwork: false,
  sourceUrlComment: false,
  subfolder: 'Summer 2026',
} satisfies DownloadOptions

describe('DownloadOptionsSchema', () => {
  it.each([
    ['the defaults', options],
    ['options with a playlist subfolder', playlistOptions],
  ])('parses %s unchanged', (_label, input) => {
    expect(DownloadOptionsSchema.parse(input)).toStrictEqual(input)
  })

  it.each(['format', 'filenameTemplate', 'embedArtwork', 'sourceUrlComment'])(
    'requires %s',
    (field) => {
      expect(issuePaths(DownloadOptionsSchema, without(options, field))).toEqual([[field]])
    },
  )

  it('trims the subfolder', () => {
    const input = { ...options, subfolder: '  Summer 2026  ' }
    expect(DownloadOptionsSchema.parse(input).subfolder).toBe('Summer 2026')
  })

  it.each(['', '   '])('rejects the blank subfolder %j (omit it instead)', (subfolder) => {
    expect(issuePaths(DownloadOptionsSchema, { ...options, subfolder })).toEqual([['subfolder']])
  })

  it('caps the subfolder at MAX_SUBFOLDER_LENGTH characters after trimming', () => {
    const longest = 'a'.repeat(MAX_SUBFOLDER_LENGTH)
    expect(DownloadOptionsSchema.parse({ ...options, subfolder: ` ${longest} ` }).subfolder).toBe(
      longest,
    )
    expect(issuePaths(DownloadOptionsSchema, { ...options, subfolder: `${longest}a` })).toEqual([
      ['subfolder'],
    ])
  })

  it('leaves making one safe folder name of the subfolder to the server', () => {
    const input = { ...options, subfolder: 'House / Techno: 2026' }
    expect(DownloadOptionsSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['an invalid filename template', 'filenameTemplate', '{artist}'],
    ['an Opus target', 'format', 'opus'],
    ['a string flag', 'embedArtwork', 'true'],
    ['a numeric flag', 'sourceUrlComment', 1],
  ])('rejects %s', (_label, field, value) => {
    expect(issuePaths(DownloadOptionsSchema, { ...options, [field]: value })).toEqual([[field]])
  })

  it('makes only the subfolder optional', () => {
    expectTypeOf<OptionalKeys<DownloadOptions>>().toEqualTypeOf<'subfolder'>()
  })
})

const request = {
  items: [youtubeRef, soundcloudRowRef],
  folder: '/Users/dj/Music/DJ Scraper',
  options: playlistOptions,
  label: 'Summer 2026',
} satisfies DownloadRequest

/** `count` distinct bare SoundCloud rows. */
const rows = (count: number): TrackRef[] =>
  Array.from({ length: count }, (_, index) => ({
    ...soundcloudRowRef,
    id: String(1_000_000 + index),
    url: `https://api-v2.soundcloud.com/tracks/${1_000_000 + index}`,
  }))

describe('DownloadRequestSchema', () => {
  it.each([
    ['a labelled playlist request', request],
    ['a single track without a label', { ...without(request, 'label'), items: [youtubeRef] }],
  ])('parses %s unchanged', (_label, input) => {
    expect(DownloadRequestSchema.parse(input)).toStrictEqual(input)
  })

  it.each(['items', 'folder', 'options'])('requires %s', (field) => {
    expect(issuePaths(DownloadRequestSchema, without(request, field))).toEqual([[field]])
  })

  it.each([1, MAX_DOWNLOAD_ITEMS])('accepts %i items', (count) => {
    expect(issuePaths(DownloadRequestSchema, { ...request, items: rows(count) })).toEqual([])
  })

  it.each([
    ['no items', []],
    ['more than MAX_DOWNLOAD_ITEMS items', rows(MAX_DOWNLOAD_ITEMS + 1)],
    ['a single ref instead of a list', youtubeRef],
  ])('rejects %s', (_label, items) => {
    expect(issuePaths(DownloadRequestSchema, { ...request, items })).toEqual([['items']])
  })

  it('reports the index of a bad item', () => {
    const items = [youtubeRef, { ...soundcloudRowRef, url: 'javascript:alert(1)' }]
    expect(issuePaths(DownloadRequestSchema, { ...request, items })).toEqual([['items', 1, 'url']])
  })

  it('takes a whole listed playlist in one request', () => {
    expect(MAX_DOWNLOAD_ITEMS).toBe(MAX_COLLECTION_ENTRIES)
  })

  it.each([
    ['with the trailing slash the picker returns', '/Volumes/USB/'],
    ['relative to home', '~/Music'],
    ['relative', 'Music'],
    ['with a .. segment', '/Users/dj/../Music'],
    ['empty', ''],
  ])('rejects a folder %s: clients send normalized paths', (_label, folder) => {
    expect(issuePaths(DownloadRequestSchema, { ...request, folder })).toEqual([['folder']])
  })

  it('reports a bad option at its nested path', () => {
    const input = { ...request, options: { ...playlistOptions, subfolder: ' ' } }
    expect(issuePaths(DownloadRequestSchema, input)).toEqual([['options', 'subfolder']])
  })

  it('trims the label', () => {
    expect(DownloadRequestSchema.parse({ ...request, label: '  Summer 2026 ' }).label).toBe(
      'Summer 2026',
    )
  })

  it.each(['', '  '])('rejects the blank label %j (omit it instead)', (label) => {
    expect(issuePaths(DownloadRequestSchema, { ...request, label })).toEqual([['label']])
  })

  it('caps the label at MAX_BATCH_LABEL_LENGTH characters after trimming', () => {
    const longest = 'a'.repeat(MAX_BATCH_LABEL_LENGTH)
    expect(DownloadRequestSchema.parse({ ...request, label: ` ${longest} ` }).label).toBe(longest)
    expect(issuePaths(DownloadRequestSchema, { ...request, label: `${longest}a` })).toEqual([
      ['label'],
    ])
  })

  it('types the request with TrackRef items and a FolderPath', () => {
    expectTypeOf<DownloadRequest>().toEqualTypeOf<{
      items: TrackRef[]
      folder: FolderPath
      options: DownloadOptions
      label?: string | undefined
    }>()
    expectTypeOf<z.input<typeof DownloadRequestSchema>>().toEqualTypeOf<DownloadRequest>()
  })
})

describe('CreateDownloadsResponseSchema', () => {
  it.each([
    [
      'a new batch whose third item repeats the first',
      { batchId: testUuid(100), jobIds: [testUuid(1), testUuid(2), testUuid(1)], duplicates: 1 },
    ],
    [
      'a request whose every item was already queued (no batch)',
      { jobIds: [testUuid(1), testUuid(2)], duplicates: 2 },
    ],
  ])('parses %s unchanged', (_label, input) => {
    expect(CreateDownloadsResponseSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['a batchId that is not a UUID', 'batchId', 'batch-1', ['batchId']],
    ['a job id that is not a UUID', 'jobIds', ['job-1'], ['jobIds', 0]],
    ['a negative duplicate count', 'duplicates', -1, ['duplicates']],
    ['a fractional duplicate count', 'duplicates', 0.5, ['duplicates']],
  ])('rejects %s', (_label, field, value, path) => {
    const input = { batchId: testUuid(100), jobIds: [testUuid(1)], duplicates: 0, [field]: value }
    expect(issuePaths(CreateDownloadsResponseSchema, input)).toEqual([path])
  })

  it('makes only batchId optional', () => {
    expectTypeOf<OptionalKeys<CreateDownloadsResponse>>().toEqualTypeOf<'batchId'>()
  })
})

/** Which statuses are final: the job won't change again unless retried. */
const terminalByStatus: Record<JobStatus, boolean> = {
  queued: false,
  downloading: false,
  processing: false,
  done: true,
  failed: true,
  canceled: true,
  skipped: true,
}

describe('job statuses', () => {
  it.each(JobStatusSchema.options.map((status) => [status, terminalByStatus[status]] as const))(
    'isTerminalStatus(%j) is %s',
    (status, terminal) => {
      expect(isTerminalStatus(status)).toBe(terminal)
    },
  )

  it('lists exactly the terminal statuses in TERMINAL_JOB_STATUSES', () => {
    const expected = JobStatusSchema.options.filter((status) => terminalByStatus[status])
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual([...expected].sort())
  })

  it('retries from failed or canceled only', () => {
    expect(RetryableStatusSchema.options).toEqual(['failed', 'canceled'])
    for (const status of JobStatusSchema.options) {
      expect(RetryableStatusSchema.safeParse(status).success).toBe(
        status === 'failed' || status === 'canceled',
      )
    }
  })

  it('types the status sets as subsets of JobStatus', () => {
    expectTypeOf<RetryableStatus>().toEqualTypeOf<'failed' | 'canceled'>()
    expectTypeOf<(typeof TERMINAL_JOB_STATUSES)[number]>().toExtend<JobStatus>()
    expectTypeOf<JobStatus>().toEqualTypeOf<
      'queued' | 'downloading' | 'processing' | 'done' | 'failed' | 'canceled' | 'skipped'
    >()
  })
})

/** Whether "Retry failed" tries a job that failed with the code. A Record, so a new code must be added. */
const retryableByCode: Record<ErrorCode, boolean> = {
  invalid_url: false,
  unsupported_url: false,
  unavailable: false,
  private: false,
  geo_blocked: false,
  age_restricted: false,
  login_required: false,
  bot_check: true,
  rate_limited: true,
  preview_only: false,
  network: true,
  engine_missing: true,
  postprocess_failed: true,
  disk_full: true,
  folder_unavailable: true,
  canceled: false,
  invalid_request: false,
  forbidden: false,
  not_found: false,
  unknown: true,
}

describe('isRetryableError', () => {
  it.each(ErrorCodeSchema.options.map((code) => [code, retryableByCode[code]] as const))(
    'isRetryableError(%j) is %s',
    (code, retryable) => {
      expect(isRetryableError(code)).toBe(retryable)
    },
  )

  it('never retries a reason a track is unavailable: trying again cannot change it', () => {
    for (const reason of UnavailableReasonSchema.options) {
      expect(isRetryableError(reason)).toBe(false)
    }
  })
})

describe('JobProgressSchema', () => {
  it.each([
    ['full byte progress', jobsByStatus.downloading.progress],
    ['fragment progress with only a percent', { percent: 12.5 }],
    ['a site-imposed wait', { waitingUntil: '2026-10-02T08:05:00Z' }],
    ['no numbers yet', {}],
    ['the bounds', { percent: 100, downloadedBytes: 0, speedBps: 0, etaSec: 0 }],
    ['zero percent', { percent: 0 }],
  ])('parses %s unchanged', (_label, progress) => {
    expect(JobProgressSchema.parse(progress)).toStrictEqual(progress)
  })

  it.each([
    ['percent', -0.01],
    ['percent', 100.01],
    ['percent', Number.NaN],
    ['percent', Number.POSITIVE_INFINITY],
    ['downloadedBytes', -1],
    ['totalBytes', 0],
    ['speedBps', -1],
    ['etaSec', -1],
    ['etaSec', Number.POSITIVE_INFINITY],
  ])('rejects %s %s', (field, value) => {
    expect(issuePaths(JobProgressSchema, { [field]: value })).toEqual([[field]])
  })

  it('accepts waitingUntil with and without milliseconds', () => {
    for (const waitingUntil of ['2026-10-02T08:05:00Z', '2026-10-02T08:05:00.123Z']) {
      expect(issuePaths(JobProgressSchema, { waitingUntil })).toEqual([])
    }
  })

  it.each([
    ['an offset instead of Z', '2026-10-02T10:05:00+02:00'],
    ['a date without a time', '2026-10-02'],
    ['a space separator', '2026-10-02 08:05:00Z'],
    ['an impossible month', '2026-13-02T08:05:00Z'],
    ['yt-dlp’s raw available_at in epoch seconds', 1_790_841_900],
  ])('rejects a waitingUntil with %s', (_label, waitingUntil) => {
    expect(issuePaths(JobProgressSchema, { waitingUntil })).toEqual([['waitingUntil']])
  })

  it('makes every field optional', () => {
    expectTypeOf<OptionalKeys<JobProgress>>().toEqualTypeOf<keyof JobProgress>()
  })
})

describe('JobOutputSchema', () => {
  it.each([
    ['an MP3 encoded from Opus', jobsByStatus.done.output],
    [
      'an M4A copied from YouTube AAC',
      {
        ext: 'm4a',
        codec: 'aac',
        bitrateKbps: 129.502,
        sampleRateHz: 44_100,
        channels: 2,
        encoded: false,
      },
    ],
    [
      'an AIFF (lossless PCM, no bitrate)',
      { ext: 'aiff', codec: 'pcm_s16be', sampleRateHz: 48_000, channels: 2, encoded: true },
    ],
    [
      'an original WebM with the Opus stream copied',
      {
        ext: 'webm',
        codec: 'opus',
        bitrateKbps: 135.817,
        sampleRateHz: 48_000,
        channels: 2,
        encoded: false,
      },
    ],
    ['an output with only the required fields', { ext: 'mp3', codec: 'mp3', encoded: false }],
  ])('parses %s unchanged', (_label, output) => {
    expect(JobOutputSchema.parse(output)).toStrictEqual(output)
  })

  it.each(['mp3', 'm4a', 'aiff', 'wav', 'flac', 'webm', 'opus', 'ogg'])(
    'accepts the extension %j from the muxer table',
    (ext) => {
      expect(issuePaths(JobOutputSchema, { ...jobsByStatus.done.output, ext })).toEqual([])
    },
  )

  it.each(['', 'MP3', '.mp3', 'mp3 ', 'tar.gz', 'webm2x', 'm4a/', '../x'])(
    'rejects the extension %j',
    (ext) => {
      expect(issuePaths(JobOutputSchema, { ...jobsByStatus.done.output, ext })).toEqual([['ext']])
    },
  )

  it.each([
    ['codec', ''],
    ['bitrateKbps', 0],
    ['sampleRateHz', 0],
    ['sampleRateHz', 44_100.5],
    ['channels', 0],
    ['channels', 1.5],
    ['encoded', 'false'],
  ])('rejects %s %j', (field, value) => {
    expect(issuePaths(JobOutputSchema, { ...jobsByStatus.done.output, [field]: value })).toEqual([
      [field],
    ])
  })

  it.each(['ext', 'codec', 'encoded'])('requires %s', (field) => {
    expect(issuePaths(JobOutputSchema, without(jobsByStatus.done.output, field))).toEqual([[field]])
  })

  it('makes the numbers optional and the encode flag required', () => {
    expectTypeOf<OptionalKeys<JobOutput>>().toEqualTypeOf<
      'bitrateKbps' | 'sampleRateHz' | 'channels'
    >()
    expectTypeOf<JobOutput['encoded']>().toEqualTypeOf<boolean>()
  })
})

type JobIn<S extends JobStatus> = Extract<Job, { status: S }>

/** A valid value for every field that only some states carry. */
const stateFields = {
  lastError: { code: 'rate_limited', message: 'YouTube is limiting downloads. Waiting to retry.' },
  progress: { percent: 10 },
  outputPath: jobsByStatus.done.outputPath,
  output: jobsByStatus.done.output,
  error: jobsByStatus.failed.error,
  finishedAt: jobsByStatus.done.finishedAt,
}
type StateField = keyof typeof stateFields

/** The state fields each status carries. */
const ownStateFields: Record<JobStatus, readonly StateField[]> = {
  queued: ['lastError'],
  downloading: ['progress'],
  processing: [],
  done: ['outputPath', 'output', 'finishedAt'],
  skipped: ['outputPath', 'finishedAt'],
  failed: ['error', 'finishedAt'],
  canceled: ['finishedAt'],
}

const foreignStateFields = (status: JobStatus): Record<string, unknown> => {
  const own: readonly string[] = ownStateFields[status]
  return Object.fromEntries(Object.entries(stateFields).filter(([field]) => !own.includes(field)))
}

/** Sent back to the queue after a rate limit: the job remembers why it waits. */
const requeuedJob = {
  ...jobsByStatus.queued,
  startedAt: '2026-10-02T08:00:05.000Z',
  lastError: { code: 'rate_limited', message: 'YouTube is limiting downloads. Waiting to retry.' },
} satisfies JobIn<'queued'>

/** Cancel was asked while it downloaded. */
const cancelingJob = {
  ...jobsByStatus.downloading,
  cancelRequested: true,
} satisfies JobIn<'downloading'>

const jobBaseRequiredFields = [
  'id',
  'batchId',
  'track',
  'format',
  'folder',
  'attempt',
  'createdAt',
] as const

describe('JobSchema', () => {
  it.each(JobStatusSchema.options)('parses a %s job unchanged', (status) => {
    const job = jobsByStatus[status]
    expect(JobSchema.parse(job)).toStrictEqual(job)
  })

  it.each([
    ['a requeued job with its last error', requeuedJob],
    ['a downloading job asked to cancel', cancelingJob],
    [
      'a downloading job before its first progress line',
      without(jobsByStatus.downloading, 'progress'),
    ],
  ])('parses %s unchanged', (_label, job) => {
    expect(JobSchema.parse(job)).toStrictEqual(job)
  })

  it.each([
    ['an unknown status', { ...jobsByStatus.queued, status: 'paused' }],
    ['a capitalised status', { ...jobsByStatus.done, status: 'Done' }],
    ['a missing status', without(jobsByStatus.queued, 'status')],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(JobSchema, input)).toEqual([['status']])
  })

  it.each([
    ['done', 'outputPath'],
    ['done', 'output'],
    ['done', 'finishedAt'],
    ['skipped', 'outputPath'],
    ['skipped', 'finishedAt'],
    ['failed', 'error'],
    ['failed', 'finishedAt'],
    ['canceled', 'finishedAt'],
  ] as const)('requires a %s job to carry %s', (status, field) => {
    expect(issuePaths(JobSchema, without(jobsByStatus[status], field))).toEqual([[field]])
  })

  it.each(JobStatusSchema.options)('strips the fields of other states from a %s job', (status) => {
    const job = jobsByStatus[status]
    expect(JobSchema.parse({ ...job, ...foreignStateFields(status) })).toStrictEqual(job)
  })

  it('does not take a done job relabelled as failed', () => {
    expect(issuePaths(JobSchema, { ...jobsByStatus.done, status: 'failed' })).toEqual([['error']])
  })

  it.each(jobBaseRequiredFields)('requires %s in every state', (field) => {
    for (const job of Object.values(jobsByStatus)) {
      expect(issuePaths(JobSchema, without(job, field))).toEqual([[field]])
    }
  })

  it.each([
    ['a first attempt of 0', 'attempt', 0],
    ['a fractional attempt', 'attempt', 1.5],
    ['an attempt as a string', 'attempt', '1'],
    ['a createdAt with an offset', 'createdAt', '2026-10-02T10:00:00+02:00'],
    ['a createdAt in epoch milliseconds', 'createdAt', 1_790_841_600_000],
    ['a startedAt that is not a timestamp', 'startedAt', 'yesterday'],
    ['a folder with a trailing slash', 'folder', '/Volumes/USB/'],
    ['a relative folder', 'folder', 'Music'],
    ['an Opus format', 'format', 'opus'],
    ['cancelRequested false (omit it instead)', 'cancelRequested', false],
    ['an empty source', 'source', {}],
  ])('rejects %s', (_label, field, value) => {
    expect(issuePaths(JobSchema, { ...jobsByStatus.queued, [field]: value })).toEqual([[field]])
  })

  it.each([
    [
      'the track',
      'queued',
      'track',
      { ...youtubeRef, url: 'javascript:alert(1)' },
      ['track', 'url'],
    ],
    ['the progress', 'downloading', 'progress', { percent: 101 }, ['progress', 'percent']],
    [
      'the output',
      'done',
      'output',
      { ...jobsByStatus.done.output, ext: 'MP3' },
      ['output', 'ext'],
    ],
    ['the error', 'failed', 'error', { code: 'teapot', message: 'No.' }, ['error', 'code']],
    [
      'the last error',
      'queued',
      'lastError',
      { code: 'network', message: '' },
      ['lastError', 'message'],
    ],
  ] as const)(
    'reports a bad value inside %s at its nested path',
    (_label, status, field, value, path) => {
      expect(issuePaths(JobSchema, { ...jobsByStatus[status], [field]: value })).toEqual([path])
    },
  )

  it.each(JobStatusSchema.options)('re-parses a %s job equal after a JSON round-trip', (status) => {
    const parsed = JobSchema.parse(jobsByStatus[status])
    expect(JobSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(parsed)
  })

  it('discriminates on status', () => {
    expectTypeOf<Job['status']>().toEqualTypeOf<JobStatus>()
  })

  it('keeps the state fields on their states only', () => {
    type BaseKey =
      | 'id'
      | 'batchId'
      | 'track'
      | 'format'
      | 'folder'
      | 'attempt'
      | 'createdAt'
      | 'startedAt'
      | 'source'
      | 'cancelRequested'
      | 'status'
    expectTypeOf<keyof JobIn<'queued'>>().toEqualTypeOf<BaseKey | 'lastError'>()
    expectTypeOf<keyof JobIn<'downloading'>>().toEqualTypeOf<BaseKey | 'progress'>()
    expectTypeOf<keyof JobIn<'processing'>>().toEqualTypeOf<BaseKey>()
    expectTypeOf<keyof JobIn<'done'>>().toEqualTypeOf<
      BaseKey | 'outputPath' | 'output' | 'finishedAt'
    >()
    expectTypeOf<keyof JobIn<'skipped'>>().toEqualTypeOf<BaseKey | 'outputPath' | 'finishedAt'>()
    expectTypeOf<keyof JobIn<'failed'>>().toEqualTypeOf<BaseKey | 'error' | 'finishedAt'>()
    expectTypeOf<keyof JobIn<'canceled'>>().toEqualTypeOf<BaseKey | 'finishedAt'>()
  })

  it('makes the state fields of finished jobs required and the live ones optional', () => {
    type BaseOptional = 'startedAt' | 'source' | 'cancelRequested'
    expectTypeOf<OptionalKeys<JobIn<'queued'>>>().toEqualTypeOf<BaseOptional | 'lastError'>()
    expectTypeOf<OptionalKeys<JobIn<'downloading'>>>().toEqualTypeOf<BaseOptional | 'progress'>()
    expectTypeOf<OptionalKeys<JobIn<'done'>>>().toEqualTypeOf<BaseOptional>()
    expectTypeOf<OptionalKeys<JobIn<'skipped'>>>().toEqualTypeOf<BaseOptional>()
    expectTypeOf<OptionalKeys<JobIn<'failed'>>>().toEqualTypeOf<BaseOptional>()
    expectTypeOf<OptionalKeys<JobIn<'canceled'>>>().toEqualTypeOf<BaseOptional>()
  })

  it('types the shared fields with the contract types', () => {
    expectTypeOf<Job['track']>().toEqualTypeOf<TrackRef>()
    expectTypeOf<Job['format']>().toEqualTypeOf<DownloadFormat>()
    expectTypeOf<Job['source']>().toEqualTypeOf<AudioSource | undefined>()
    expectTypeOf<Job['cancelRequested']>().toEqualTypeOf<true | undefined>()
    expectTypeOf<JobIn<'done'>['output']>().toEqualTypeOf<JobOutput>()
    expectTypeOf<JobIn<'failed'>['error']>().toEqualTypeOf<ErrorInfo>()
    expectTypeOf<JobIn<'queued'>['lastError']>().toEqualTypeOf<ErrorInfo | undefined>()
    expectTypeOf<JobIn<'downloading'>['progress']>().toEqualTypeOf<JobProgress | undefined>()
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof JobSchema>>().toEqualTypeOf<Job>()
  })

  it('narrows to the state fields when switching on status', () => {
    const fileOf = (job: Job): string | undefined => {
      switch (job.status) {
        case 'done':
        case 'skipped':
          return job.outputPath
        case 'queued':
        case 'downloading':
        case 'processing':
        case 'failed':
        case 'canceled':
          return undefined
        default:
          return job satisfies never
      }
    }
    expect(fileOf(JobSchema.parse(jobsByStatus.done))).toBe(jobsByStatus.done.outputPath)
    expect(fileOf(JobSchema.parse(jobsByStatus.failed))).toBeUndefined()
  })
})

describe('UUID ids', () => {
  it.each([
    ['a made-up id', 'job-1'],
    ['an empty string', ''],
    ['a version-0 UUID', '00000000-0000-0000-0000-000000000001'],
    ['a UUID with a non-RFC variant', '00000000-0000-4000-0000-000000000001'],
    ['a UUID without hyphens', '00000000000040008000000000000001'],
    ['a UUID in braces', `{${testUuid(1)}}`],
    ['a UUID with a leading space', ` ${testUuid(1)}`],
  ])('rejects %s as a job id', (_label, id) => {
    expect(issuePaths(JobSchema, { ...jobsByStatus.queued, id })).toEqual([['id']])
  })

  it('accepts a crypto.randomUUID() id', () => {
    const id = '9f1c6c1e-3b9a-4c8e-a0d5-2f7e4b1a6c3d'
    expect(issuePaths(JobSchema, { ...jobsByStatus.queued, id })).toEqual([])
  })

  it('builds distinct version-4 ids with testUuid', () => {
    const ids = [0, 1, 255, 2 ** 48 - 1].map(testUuid)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(issuePaths(JobSchema, { ...jobsByStatus.queued, id })).toEqual([])
    }
  })

  it.each([-1, 1.5, 2 ** 48, Number.NaN])('refuses to build a testUuid from %s', (n) => {
    expect(() => testUuid(n)).toThrow(RangeError)
  })
})

describe('BatchSchema', () => {
  it.each([
    ['a labelled batch', testBatch],
    ['a batch without a label', without(testBatch, 'label')],
  ])('parses %s unchanged', (_label, batch) => {
    expect(BatchSchema.parse(batch)).toStrictEqual(batch)
  })

  it.each(['id', 'folder', 'format', 'createdAt'])('requires %s', (field) => {
    expect(issuePaths(BatchSchema, without(testBatch, field))).toEqual([[field]])
  })

  it('trims the label like the request does', () => {
    expect(BatchSchema.parse({ ...testBatch, label: ' Summer 2026  ' }).label).toBe('Summer 2026')
  })

  it.each([
    ['a blank label', 'label', '   '],
    ['a label over MAX_BATCH_LABEL_LENGTH', 'label', 'a'.repeat(MAX_BATCH_LABEL_LENGTH + 1)],
    ['an id that is not a UUID', 'id', 'batch-1'],
    ['a folder with a trailing slash', 'folder', '/Volumes/USB/'],
    ['the format of a final file instead of a target', 'format', 'webm'],
    ['a createdAt with an offset', 'createdAt', '2026-10-02T10:00:00+02:00'],
  ])('rejects %s', (_label, field, value) => {
    expect(issuePaths(BatchSchema, { ...testBatch, [field]: value })).toEqual([[field]])
  })

  it('makes only the label optional', () => {
    expectTypeOf<OptionalKeys<Batch>>().toEqualTypeOf<'label'>()
  })
})

const youtubePaused = {
  platform: 'youtube',
  pausedUntil: '2026-10-02T08:10:00.000Z',
  pauseCode: 'rate_limited',
} satisfies PlatformQueueState

const soundcloudPaced = {
  platform: 'soundcloud',
  nextStartAt: '2026-10-02T08:00:05.000Z',
} satisfies PlatformQueueState

describe('PauseCodeSchema', () => {
  it.each(['rate_limited', 'bot_check'])('accepts %j', (code) => {
    expect(PauseCodeSchema.parse(code)).toBe(code)
  })

  it.each(['network', 'unknown', 'preview_only'])(
    'rejects %j, which never pauses a platform',
    (code) => {
      expect(PauseCodeSchema.safeParse(code).success).toBe(false)
    },
  )

  it('is the two platform-limit error codes', () => {
    expectTypeOf<PauseCode>().toEqualTypeOf<'rate_limited' | 'bot_check'>()
    expectTypeOf<PauseCode>().toExtend<ErrorCode>()
  })
})

describe('PlatformQueueStateSchema', () => {
  it.each([
    ['a platform paused by a rate limit', youtubePaused],
    ['a platform held back by pacing', soundcloudPaced],
    [
      'a paused platform that also knows its next start',
      { ...youtubePaused, nextStartAt: '2026-10-02T08:10:00.000Z' },
    ],
  ])('parses %s unchanged', (_label, state) => {
    expect(PlatformQueueStateSchema.parse(state)).toStrictEqual(state)
  })

  it('requires the platform', () => {
    expect(issuePaths(PlatformQueueStateSchema, without(youtubePaused, 'platform'))).toEqual([
      ['platform'],
    ])
  })
})

describe('QueueStateSchema', () => {
  it.each([
    ['a paused and a paced platform', { platforms: [youtubePaused, soundcloudPaced] }],
    ['nothing to report', { platforms: [] }],
    ['a YouTube bot check', { platforms: [{ ...youtubePaused, pauseCode: 'bot_check' }] }],
  ])('parses %s unchanged', (_label, queue) => {
    expect(QueueStateSchema.parse(queue)).toStrictEqual(queue)
  })

  it('requires the platform list', () => {
    expect(issuePaths(QueueStateSchema, {})).toEqual([['platforms']])
  })

  it.each([
    ['an out-of-scope platform', 'platform', 'spotify'],
    ['a pause code that is not a platform limit', 'pauseCode', 'network'],
    ['a pausedUntil with an offset', 'pausedUntil', '2026-10-02T10:10:00+02:00'],
    ['a nextStartAt in epoch milliseconds', 'nextStartAt', 1_790_841_605_000],
  ])('reports %s at its index', (_label, field, value) => {
    const queue = { platforms: [soundcloudPaced, { ...youtubePaused, [field]: value }] }
    expect(issuePaths(QueueStateSchema, queue)).toEqual([['platforms', 1, field]])
  })

  it('lists platforms with optional pause and pacing times', () => {
    expectTypeOf<OptionalKeys<PlatformQueueState>>().toEqualTypeOf<
      'pausedUntil' | 'pauseCode' | 'nextStartAt'
    >()
    expectTypeOf<PlatformQueueState['platform']>().toEqualTypeOf<Platform>()
    expectTypeOf<QueueState>().toEqualTypeOf<{ platforms: PlatformQueueState[] }>()
  })
})

const snapshot = {
  serverId: testUuid(900),
  jobs: Object.values(jobsByStatus),
  batches: [testBatch],
  queue: { platforms: [youtubePaused] },
} satisfies DownloadsSnapshot

describe('DownloadsSnapshotSchema', () => {
  it.each([
    ['a snapshot with a job in every status', snapshot],
    [
      'the empty snapshot of a fresh server',
      { serverId: testUuid(901), jobs: [], batches: [], queue: { platforms: [] } },
    ],
  ])('parses %s unchanged', (_label, input) => {
    expect(DownloadsSnapshotSchema.parse(input)).toStrictEqual(input)
  })

  it.each(['serverId', 'jobs', 'batches', 'queue'])('requires %s', (field) => {
    expect(issuePaths(DownloadsSnapshotSchema, without(snapshot, field))).toEqual([[field]])
  })

  it('rejects a serverId that is not a UUID', () => {
    const input = { ...snapshot, serverId: 'server-1' }
    expect(issuePaths(DownloadsSnapshotSchema, input)).toEqual([['serverId']])
  })

  it('reports a bad job at its index', () => {
    const input = { ...snapshot, jobs: [jobsByStatus.queued, without(jobsByStatus.done, 'output')] }
    expect(issuePaths(DownloadsSnapshotSchema, input)).toEqual([['jobs', 1, 'output']])
  })

  it('re-parses equal after a JSON round-trip, as the GET /api/downloads body', () => {
    const parsed = DownloadsSnapshotSchema.parse(snapshot)
    expect(DownloadsSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(parsed)
  })

  it('types the snapshot with the contract types', () => {
    expectTypeOf<DownloadsSnapshot>().toEqualTypeOf<{
      serverId: string
      jobs: Job[]
      batches: Batch[]
      queue: QueueState
    }>()
    expectTypeOf<z.input<typeof DownloadsSnapshotSchema>>().toEqualTypeOf<DownloadsSnapshot>()
  })
})

describe('JobScopeSchema', () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, n) => testUuid(n))

  it.each([
    ['every job', { scope: 'all' }],
    ['one batch', { scope: 'batch', batchId: testBatch.id }],
    ['one job', { scope: 'jobs', ids: ids(1) }],
    ['MAX_DOWNLOAD_ITEMS jobs', { scope: 'jobs', ids: ids(MAX_DOWNLOAD_ITEMS) }],
  ])('parses %s unchanged', (_label, scope) => {
    expect(JobScopeSchema.parse(scope)).toStrictEqual(scope)
  })

  it.each([
    ['an unknown scope', { scope: 'failed' }, ['scope']],
    ['a missing scope', { batchId: testBatch.id }, ['scope']],
    ['a batch scope without its batchId', { scope: 'batch' }, ['batchId']],
    ['a batchId that is not a UUID', { scope: 'batch', batchId: 'batch-1' }, ['batchId']],
    ['a jobs scope without ids', { scope: 'jobs' }, ['ids']],
    ['an empty id list', { scope: 'jobs', ids: [] }, ['ids']],
    [
      'more than MAX_DOWNLOAD_ITEMS ids',
      { scope: 'jobs', ids: ids(MAX_DOWNLOAD_ITEMS + 1) },
      ['ids'],
    ],
    ['an id that is not a UUID', { scope: 'jobs', ids: [testUuid(1), 'job-2'] }, ['ids', 1]],
  ])('rejects %s', (_label, scope, path) => {
    expect(issuePaths(JobScopeSchema, scope)).toEqual([path])
  })

  it('discriminates on scope', () => {
    expectTypeOf<JobScope>().toEqualTypeOf<
      { scope: 'all' } | { scope: 'batch'; batchId: string } | { scope: 'jobs'; ids: string[] }
    >()
  })
})

describe.each([
  ['CancelJobsRequestSchema', CancelJobsRequestSchema],
  ['ClearJobsRequestSchema', ClearJobsRequestSchema],
])('%s', (_name, schema) => {
  it('parses a scoped request unchanged', () => {
    const input = { target: { scope: 'batch', batchId: testBatch.id } }
    expect(schema.parse(input)).toStrictEqual(input)
  })

  it('requires a target', () => {
    expect(issuePaths(schema, {})).toEqual([['target']])
  })

  it('reports a bad scope under target', () => {
    expect(issuePaths(schema, { target: { scope: 'everything' } })).toEqual([['target', 'scope']])
  })
})

describe('cancel and clear request types', () => {
  it('wrap a JobScope', () => {
    expectTypeOf<CancelJobsRequest>().toEqualTypeOf<{ target: JobScope }>()
    expectTypeOf<ClearJobsRequest>().toEqualTypeOf<{ target: JobScope }>()
  })
})

describe('RetryJobsRequestSchema', () => {
  const target = { scope: 'all' } as const

  it('retries failed jobs by default', () => {
    expect(RetryJobsRequestSchema.parse({ target })).toStrictEqual({
      target,
      statuses: ['failed'],
    })
  })

  it('keeps explicit statuses', () => {
    const input = { target, statuses: ['failed', 'canceled'] }
    expect(RetryJobsRequestSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['a status retry does not start from', ['done'], ['statuses', 0]],
    ['a running status', ['failed', 'downloading'], ['statuses', 1]],
    ['an empty list', [], ['statuses']],
    ['a single status instead of a list', 'failed', ['statuses']],
  ])('rejects %s', (_label, statuses, path) => {
    expect(issuePaths(RetryJobsRequestSchema, { target, statuses })).toEqual([path])
  })

  it('requires a target', () => {
    expect(issuePaths(RetryJobsRequestSchema, { statuses: ['failed'] })).toEqual([['target']])
  })

  it('makes statuses optional on input and always present on output', () => {
    expectTypeOf<z.input<typeof RetryJobsRequestSchema>>().toEqualTypeOf<{
      target: JobScope
      statuses?: RetryableStatus[] | undefined
    }>()
    expectTypeOf<RetryJobsRequest>().toEqualTypeOf<{
      target: JobScope
      statuses: RetryableStatus[]
    }>()
  })
})

describe('BulkJobsResponseSchema', () => {
  it.each([0, 12])('parses a count of %i', (count) => {
    expect(BulkJobsResponseSchema.parse({ count })).toStrictEqual({ count })
  })

  it.each([-1, 1.5, '3', Number.NaN])('rejects the count %j', (count) => {
    expect(issuePaths(BulkJobsResponseSchema, { count })).toEqual([['count']])
  })

  it('is just a count', () => {
    expectTypeOf<BulkJobsResponse>().toEqualTypeOf<{ count: number }>()
  })
})
