import { type DownloadFormat, DownloadFormatSchema, QueueStateSchema } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { formatClock } from '@/lib/format.ts'
import { batch, doneJob, jobWith, queuedJob } from '@/test/downloads.ts'
import {
  batchProgressLabel,
  batchProgressText,
  batchTitle,
  countsText,
  formatName,
  platformQueueNote,
  queueNotes,
} from './panel-text.ts'
import { emptySummary, type StatusCounts, summarizeJobs } from './summary.ts'

const counts = (changes: Partial<StatusCounts>): StatusCounts => ({
  ...emptySummary().counts,
  ...changes,
})

describe('countsText', () => {
  it('names done, skipped, failed, canceled and left, in that order', () => {
    expect(
      countsText(
        counts({
          queued: 1,
          downloading: 1,
          processing: 1,
          done: 8,
          skipped: 2,
          failed: 1,
          canceled: 4,
        }),
      ),
    ).toBe('8 done · 2 skipped · 1 failed · 4 canceled · 3 left')
  })

  it('leaves out counts of zero', () => {
    expect(countsText(counts({ done: 8, failed: 1, queued: 3 }))).toBe('8 done · 1 failed · 3 left')
    expect(countsText(counts({ downloading: 2 }))).toBe('2 left')
  })

  it('is empty for no jobs, and groups thousands', () => {
    expect(countsText(counts({}))).toBe('')
    expect(countsText(counts({ queued: 4999, done: 1 }))).toBe('1 done · 4,999 left')
  })
})

describe('batch texts', () => {
  it('call a batch by its label, else by how many tracks it has', () => {
    expect(batchTitle({ batch, jobs: [queuedJob] })).toBe('Summer 2026')
    const { label: _, ...unlabeled } = batch
    expect(batchTitle({ batch: unlabeled, jobs: [queuedJob] })).toBe('Single track')
    const jobs = Array.from({ length: 1200 }, (_, i) =>
      jobWith({ id: testUuid(i), status: 'queued' }),
    )
    expect(batchTitle({ batch: unlabeled, jobs })).toBe('1,200 tracks')
  })

  it('count the finished jobs of a batch, for the eye and for assistive tech', () => {
    const summary = summarizeJobs([queuedJob, doneJob])
    expect(batchProgressText(summary)).toBe('1/2')
    expect(batchProgressLabel(summary)).toBe('1 of 2 finished')
  })

  it('name every format', () => {
    const names = Object.fromEntries(
      DownloadFormatSchema.options.map((format: DownloadFormat) => [format, formatName(format)]),
    )
    expect(names).toEqual({
      mp3: 'MP3',
      m4a: 'M4A',
      aiff: 'AIFF',
      wav: 'WAV',
      flac: 'FLAC',
      original: 'Original',
    })
  })
})

describe('queueNotes', () => {
  const at = '2026-10-02T12:05:00.000Z'
  const clock = formatClock(at, 'en-GB')
  const notesFor = (platforms: unknown[]) =>
    queueNotes(QueueStateSchema.parse({ platforms }), 'en-GB')

  it('says until when a rate-limited platform is paused, and that it resumes by itself', () => {
    expect(
      notesFor([{ platform: 'soundcloud', pausedUntil: at, pauseCode: 'rate_limited' }]),
    ).toEqual([
      {
        platform: 'soundcloud',
        kind: 'paused',
        text: `SoundCloud paused until ${clock}: rate-limited (retries on its own)`,
      },
    ])
  })

  it('adds the yt-dlp update hint to a pause for a bot check', () => {
    expect(notesFor([{ platform: 'youtube', pausedUntil: at, pauseCode: 'bot_check' }])).toEqual([
      {
        platform: 'youtube',
        kind: 'paused',
        text: `YouTube paused until ${clock}: it asks for a bot check (retries on its own)`,
        hint: 'Updating yt-dlp usually fixes this: `brew upgrade yt-dlp`.',
      },
    ])
  })

  it('leaves the reason out of a pause without a code', () => {
    expect(notesFor([{ platform: 'other', pausedUntil: at }])[0]?.text).toBe(
      `Other sites paused until ${clock} (retries on its own)`,
    )
  })

  it('says when a paced platform starts its next job', () => {
    expect(notesFor([{ platform: 'youtube', nextStartAt: at }])).toEqual([
      {
        platform: 'youtube',
        kind: 'paced',
        text: `YouTube: next start at ${clock} (paced to stay under its limits)`,
      },
    ])
  })

  it('shows only the pause of a platform that is paused and paced, one note per platform', () => {
    const notes = notesFor([
      { platform: 'youtube', nextStartAt: at },
      { platform: 'soundcloud', pausedUntil: at, nextStartAt: at, pauseCode: 'rate_limited' },
    ])
    expect(notes.map((note) => [note.platform, note.kind])).toEqual([
      ['youtube', 'paced'],
      ['soundcloud', 'paused'],
    ])
  })

  it('has no notes before the first snapshot, nor for a platform with nothing to report', () => {
    expect(queueNotes(undefined)).toEqual([])
    expect(notesFor([])).toEqual([])
    expect(notesFor([{ platform: 'youtube' }])).toEqual([])
  })
})

describe('platformQueueNote', () => {
  const at = '2026-10-02T12:05:00.000Z'
  const queue = QueueStateSchema.parse({
    platforms: [
      { platform: 'youtube', nextStartAt: at },
      { platform: 'soundcloud', pausedUntil: at, pauseCode: 'rate_limited' },
    ],
  })

  it("picks the note of one platform: why that platform's queued jobs wait", () => {
    expect(platformQueueNote(queue, 'youtube', 'en-GB')).toEqual(queueNotes(queue, 'en-GB')[0])
    expect(platformQueueNote(queue, 'soundcloud', 'en-GB')?.kind).toBe('paused')
  })

  it('has none for a platform the queue holds nothing back for, or before the first snapshot', () => {
    expect(platformQueueNote(queue, 'other')).toBeUndefined()
    expect(
      platformQueueNote(
        QueueStateSchema.parse({ platforms: [{ platform: 'youtube' }] }),
        'youtube',
      ),
    ).toBeUndefined()
    expect(platformQueueNote(undefined, 'youtube')).toBeUndefined()
  })
})
