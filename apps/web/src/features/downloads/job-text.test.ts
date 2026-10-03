import { type AudioSource, type Job, type JobOutput, JobOutputSchema } from '@dj-scraper/shared'
import { jobsByStatus, soundcloudRowRef, testUuid } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { errorHint } from '@/lib/error-text.ts'
import { formatClock } from '@/lib/format.ts'
import { doneJob, downloadingJob, failedJob, jobWith, queuedJob } from '@/test/downloads.ts'
import {
  codecLabel,
  formatKbps,
  jobArtist,
  jobErrorHint,
  jobPhase,
  jobTitle,
  outputText,
  progressText,
  sourceText,
  statusDetail,
  statusLabel,
  statusText,
  waitingText,
  waitingUntil,
} from './job-text.ts'

/** 08:01 on the fixtures' day: their jobs started at 08:00:05. */
const NOW = Date.parse('2026-10-02T08:01:00.000Z')
const IN_A_MINUTE = '2026-10-02T08:02:00.000Z'
const A_MINUTE_AGO = '2026-10-02T08:00:00.000Z'

const output = (fields: Partial<JobOutput> & Pick<JobOutput, 'ext' | 'codec' | 'encoded'>) =>
  JobOutputSchema.parse(fields)

const youtubeOpus: AudioSource = { codec: 'opus', bitrateKbps: 135.817 }
const youtubeAac: AudioSource = { codec: 'mp4a.40.2', bitrateKbps: 129.553 }
const soundcloudMp3: AudioSource = { codec: 'mp3', bitrateKbps: 128 }

describe('jobTitle and jobArtist', () => {
  it("names a job by its track's title and artist", () => {
    expect(jobTitle(doneJob)).toBe('Rick Astley - Never Gonna Give You Up (Official Music Video)')
    expect(jobArtist(doneJob)).toBe('Rick Astley')
  })

  it('falls back to the uploader, whose name the file then carries', () => {
    const job = jobWith({
      id: testUuid(10),
      status: 'queued',
      track: { ...jobsByStatus.queued.track, artist: undefined, uploader: 'Crate Diggers' },
    })
    expect(jobArtist(job)).toBe('Crate Diggers')
  })

  it('names a set row nobody looked up yet by its platform and id, with no artist', () => {
    expect(failedJob.track).toEqual(soundcloudRowRef)
    expect(jobTitle(failedJob)).toBe('SoundCloud track 1234567893')
    expect(jobArtist(failedJob)).toBeUndefined()
  })
})

describe('codecLabel', () => {
  it.each([
    ['mp3', 'MP3'],
    ['aac', 'AAC'],
    ['mp4a.40.2', 'AAC'],
    ['mp4a.40.5', 'HE-AAC'],
    ['mp4a.40.29', 'HE-AAC v2'],
    ['mp4a.67', 'AAC'],
    ['opus', 'Opus'],
    ['vorbis', 'Vorbis'],
    ['flac', 'FLAC'],
    ['FLAC', 'FLAC'],
    ['alac', 'ALAC'],
    ['ec-3', 'E-AC-3'],
    ['pcm_s16be', 'PCM'],
    ['pcm_s16le', 'PCM'],
    ['wmav2', 'WMAV2'],
  ])('calls %s "%s"', (codec, label) => {
    expect(codecLabel(codec)).toBe(label)
  })
})

describe('formatKbps', () => {
  it.each([
    // YouTube's format 140 measures a little above its nominal 128 kbps.
    [129.553, '128 kbps'],
    [128, '128 kbps'],
    [131.8, '128 kbps'],
    [256.4, '256 kbps'],
    [320, '320 kbps'],
    [98.215, '96 kbps'],
    // Opus is variable: shown as measured.
    [135.817, '136 kbps'],
    [104.6, '105 kbps'],
    // Below a nominal rate is never lifted to it.
    [125, '125 kbps'],
    [255, '255 kbps'],
  ])('shows %s as "%s"', (kbps, text) => {
    expect(formatKbps(kbps)).toBe(text)
  })
})

describe('sourceText', () => {
  it.each<[AudioSource, string]>([
    [youtubeAac, 'AAC 128 kbps'],
    [youtubeOpus, 'Opus 136 kbps'],
    [soundcloudMp3, 'MP3 128 kbps'],
    [{ codec: 'opus' }, 'Opus'],
    [{ bitrateKbps: 160 }, '160 kbps'],
  ])('describes %j as "%s"', (source, text) => {
    expect(sourceText(source)).toBe(text)
  })
})

describe('outputText', () => {
  it.each<[string, JobOutput, AudioSource | undefined, string]>([
    [
      'an MP3 encoded from Opus',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }),
      youtubeOpus,
      'MP3 · 320 kbps · re-encoded from Opus 136 kbps',
    ],
    [
      'an MP3 source kept at its own bitrate, not passed off as 320',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 128, encoded: false }),
      soundcloudMp3,
      'MP3 · 128 kbps · copied',
    ],
    [
      "YouTube's AAC copied into M4A",
      output({ ext: 'm4a', codec: 'aac', bitrateKbps: 130, encoded: false }),
      youtubeAac,
      'M4A · AAC 128 kbps · copied',
    ],
    [
      'an M4A transcoded from Opus',
      output({ ext: 'm4a', codec: 'aac', bitrateKbps: 256, encoded: true }),
      youtubeOpus,
      'M4A · AAC 256 kbps · re-encoded from Opus 136 kbps',
    ],
    [
      'an AIFF holding no more than its AAC source',
      output({ ext: 'aiff', codec: 'pcm_s16be', sampleRateHz: 44_100, channels: 2, encoded: true }),
      youtubeAac,
      'AIFF · 16-bit · from AAC 128 kbps',
    ],
    [
      'a WAV from Opus',
      output({ ext: 'wav', codec: 'pcm_s16le', encoded: true }),
      youtubeOpus,
      'WAV · 16-bit · from Opus 136 kbps',
    ],
    [
      'a 24-bit AIFF',
      output({ ext: 'aiff', codec: 'pcm_s24be', encoded: true }),
      { codec: 'flac' },
      'AIFF · 24-bit · from FLAC',
    ],
    [
      'a float WAV',
      output({ ext: 'wav', codec: 'pcm_f32le', encoded: true }),
      undefined,
      'WAV · 32-bit float · converted',
    ],
    [
      'a FLAC from an MP3',
      output({ ext: 'flac', codec: 'flac', encoded: true }),
      soundcloudMp3,
      'FLAC · from MP3 128 kbps',
    ],
    [
      'a FLAC original copied',
      output({ ext: 'flac', codec: 'flac', encoded: false }),
      { codec: 'flac' },
      'FLAC · copied',
    ],
    [
      "YouTube's Opus kept as the original",
      output({ ext: 'webm', codec: 'opus', bitrateKbps: 136, encoded: false }),
      youtubeOpus,
      'WebM · Opus 136 kbps · copied',
    ],
    [
      'an Ogg Vorbis original',
      output({ ext: 'ogg', codec: 'vorbis', bitrateKbps: 160, encoded: false }),
      { codec: 'vorbis' },
      'Ogg · Vorbis 160 kbps · copied',
    ],
    [
      'a mono file',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 128, channels: 1, encoded: false }),
      soundcloudMp3,
      'MP3 · 128 kbps · mono · copied',
    ],
    [
      'a lossy file from an unknown source',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }),
      undefined,
      'MP3 · 320 kbps · re-encoded',
    ],
    [
      'a lossless file from an unknown source',
      output({ ext: 'aiff', codec: 'pcm_s16be', encoded: true }),
      undefined,
      'AIFF · 16-bit · converted',
    ],
    [
      'a source known by its codec only',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }),
      { codec: 'opus' },
      'MP3 · 320 kbps · re-encoded from Opus',
    ],
    [
      'a source known by its bitrate only',
      output({ ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }),
      { bitrateKbps: 128 },
      'MP3 · 320 kbps · re-encoded from 128 kbps',
    ],
    [
      'an output without a bitrate',
      output({ ext: 'mp3', codec: 'mp3', encoded: false }),
      soundcloudMp3,
      'MP3 · copied',
    ],
  ])('describes %s', (_, file, source, text) => {
    expect(outputText(file, source)).toBe(text)
  })
})

describe('progressText', () => {
  it('shows the percent, speed and time left', () => {
    expect(downloadingJob.status === 'downloading' && downloadingJob.progress).toMatchObject({
      percent: 42.5,
      speedBps: 851_200,
      etaSec: 3,
    })
    if (downloadingJob.status !== 'downloading') throw new Error('unreachable')
    expect(progressText(downloadingJob.progress)).toBe('42 % · 851 kB/s · 0:03 left')
  })

  it('rounds the percent down, so it never says 100 % before the end', () => {
    expect(progressText({ percent: 99.9 })).toBe('99 %')
    expect(progressText({ percent: 0.4 })).toBe('0 %')
  })

  it('shows the size downloaded when there is no percent', () => {
    expect(progressText({ downloadedBytes: 1_712_128, totalBytes: 4_028_536 })).toBe(
      '1.7 MB of 4.0 MB',
    )
    expect(progressText({ downloadedBytes: 1_712_128, speedBps: 1_200_000 })).toBe(
      '1.7 MB · 1.2 MB/s',
    )
  })

  it('leaves out a speed of zero and fields yt-dlp did not report', () => {
    expect(progressText({ percent: 3, speedBps: 0 })).toBe('3 %')
    expect(progressText({ etaSec: 125 })).toBe('2 min left')
  })

  it('is empty without numbers: no progress yet, or only a wait', () => {
    expect(progressText(undefined)).toBe('')
    expect(progressText({})).toBe('')
    expect(progressText({ waitingUntil: IN_A_MINUTE })).toBe('')
  })
})

describe('waitingText', () => {
  it('says until when the site makes the download wait, and which site', () => {
    expect(waitingText(IN_A_MINUTE, 'youtube')).toBe(
      `Waiting until ${formatClock(IN_A_MINUTE)} (YouTube)`,
    )
    expect(waitingText(IN_A_MINUTE, 'soundcloud')).toBe(
      `Waiting until ${formatClock(IN_A_MINUTE)} (SoundCloud)`,
    )
  })

  it('names no site for other platforms or none, and no time it cannot read', () => {
    expect(waitingText(IN_A_MINUTE, 'other')).toBe(`Waiting until ${formatClock(IN_A_MINUTE)}`)
    expect(waitingText(IN_A_MINUTE)).toBe(`Waiting until ${formatClock(IN_A_MINUTE)}`)
    expect(waitingText('soon', 'youtube')).toBe('Waiting (YouTube)')
  })
})

const downloading = (fields: Record<string, unknown> = {}) =>
  jobWith({ id: testUuid(20), status: 'downloading', startedAt: A_MINUTE_AGO, ...fields })
const requeued = (code: string, message: string) =>
  jobWith({ id: testUuid(21), status: 'queued', lastError: { code, message } })

const processingJob = jobWith(jobsByStatus.processing)
const skippedJob = jobWith(jobsByStatus.skipped)
const canceledJob = jobWith(jobsByStatus.canceled)
const waitingJob = downloading({ progress: { waitingUntil: IN_A_MINUTE } })
const waitedJob = downloading({ progress: { waitingUntil: A_MINUTE_AGO } })
const rateLimited = requeued(
  'rate_limited',
  'YouTube is limiting downloads from this network for now.',
)
const doneMessage = 'MP3 · 320 kbps · re-encoded from Opus 136 kbps'
const waitingLabel = `Waiting until ${formatClock(IN_A_MINUTE)} (YouTube)`

describe('the status of a job in every state', () => {
  it.each<[string, Job, string, string, string, string | undefined]>([
    // name, job, phase, label (headline), text (list row), detail
    ['queued', queuedJob, 'queued', 'Queued', 'Queued', undefined],
    [
      'requeued after a rate limit',
      rateLimited,
      'requeued',
      'Rate-limited, retrying soon',
      'Rate-limited, retrying soon: YouTube is limiting downloads from this network for now.',
      'YouTube is limiting downloads from this network for now.',
    ],
    [
      'requeued after a bot check',
      requeued('bot_check', 'YouTube asks to confirm you are not a bot.'),
      'requeued',
      'Bot check, retrying soon',
      'Bot check, retrying soon: YouTube asks to confirm you are not a bot.',
      'YouTube asks to confirm you are not a bot.',
    ],
    [
      'requeued for another reason',
      requeued('network', 'The connection dropped.'),
      'requeued',
      'Retrying soon',
      'Retrying soon: The connection dropped.',
      'The connection dropped.',
    ],
    [
      'downloading without progress yet',
      downloading(),
      'starting',
      'Starting…',
      'Starting…',
      undefined,
    ],
    ['held by the site', waitingJob, 'waiting', waitingLabel, waitingLabel, undefined],
    ['past its wait', waitedJob, 'starting', 'Starting…', 'Starting…', undefined],
    [
      'downloading',
      downloadingJob,
      'downloading',
      'Downloading',
      '42 % · 851 kB/s · 0:03 left',
      undefined,
    ],
    [
      'downloading, cancel asked',
      downloading({ cancelRequested: true, progress: { percent: 10 } }),
      'canceling',
      'Canceling…',
      'Canceling…',
      undefined,
    ],
    [
      'processing',
      processingJob,
      'processing',
      'Converting and tagging…',
      'Converting and tagging…',
      undefined,
    ],
    [
      'processing the original',
      jobWith({ ...jobsByStatus.processing, format: 'original' }),
      'processing',
      'Finishing…',
      'Finishing…',
      undefined,
    ],
    [
      'processing, cancel asked',
      jobWith({ ...jobsByStatus.processing, cancelRequested: true }),
      'canceling',
      'Canceling…',
      'Canceling…',
      undefined,
    ],
    ['done', doneJob, 'done', 'Done', doneMessage, doneMessage],
    [
      // The file was in place before the cancel stopped it: done stands.
      'done after a cancel was asked',
      jobWith({ ...jobsByStatus.done, cancelRequested: true }),
      'done',
      'Done',
      doneMessage,
      doneMessage,
    ],
    [
      'skipped',
      skippedJob,
      'skipped',
      'Already in the folder',
      'Already in the folder',
      'Kept the file that was there: Rick Astley - Never Gonna Give You Up.mp3',
    ],
    [
      'failed',
      failedJob,
      'failed',
      'Failed',
      'The connection dropped. Retry to try again.',
      'The connection dropped. Retry to try again.',
    ],
    ['canceled', canceledJob, 'canceled', 'Canceled', 'Canceled', undefined],
  ])('%s', (_, job, phase, label, text, detail) => {
    expect(jobPhase(job, NOW)).toBe(phase)
    expect(statusLabel(job, NOW)).toBe(label)
    expect(statusText(job, NOW)).toBe(text)
    expect(statusDetail(job)).toBe(detail)
  })

  it('ends a wait at its time', () => {
    const until = Date.parse(IN_A_MINUTE)
    expect(jobPhase(waitingJob, until - 1)).toBe('waiting')
    expect(jobPhase(waitingJob, until)).toBe('starting')
    expect(statusLabel(waitingJob, until)).toBe('Starting…')
  })

  it('shows a done job made from an MP3 source as copied at its own bitrate', () => {
    const job = jobWith({
      ...jobsByStatus.done,
      source: soundcloudMp3,
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 128, encoded: false },
    })
    expect(statusText(job, NOW)).toBe('MP3 · 128 kbps · copied')
  })
})

describe('waitingUntil', () => {
  it("is a downloading job's wait, past or not, and nothing for other states", () => {
    expect(waitingUntil(waitingJob)).toBe(IN_A_MINUTE)
    expect(waitingUntil(waitedJob)).toBe(A_MINUTE_AGO)
    expect(waitingUntil(downloadingJob)).toBeUndefined()
    expect(waitingUntil(queuedJob)).toBeUndefined()
  })
})

describe('jobErrorHint', () => {
  it("says what Retry needs, never another folder or format: Retry keeps the job's", () => {
    expect(jobErrorHint('folder_unavailable')).toBe(
      'Reconnect the drive or put the folder back, then retry.',
    )
    expect(jobErrorHint('postprocess_failed')).toBe(
      'Retry; if it keeps failing, update ffmpeg: `brew upgrade ffmpeg`.',
    )
    // A refused download, by contrast, starts again with the folder and format in the header.
    expect(errorHint('folder_unavailable')).toBe('You can pick another folder in the header.')
  })

  it('names another folder for a lost one when the card can download again', () => {
    expect(jobErrorHint('folder_unavailable', true)).toBe(
      'Reconnect the drive or put the folder back, then retry. Or pick another folder in the header and download again.',
    )
  })

  it("is the code's own hint otherwise", () => {
    expect(jobErrorHint('bot_check')).toBe(errorHint('bot_check'))
    expect(jobErrorHint('disk_full')).toBe('Free up some space there, then retry.')
    expect(jobErrorHint('private')).toBeUndefined()
  })
})
