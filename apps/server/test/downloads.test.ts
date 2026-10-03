import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  BulkJobsResponseSchema,
  isTerminalStatus,
  type Job,
  JobSchema,
  type JobStatus,
  type ServerEvent,
  SSE_RETRY_MS,
  type TrackRef,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PREVIEW_ONLY } from '../src/engine/ytdlp-errors.ts'
import {
  type DownloadsApp,
  isEvent,
  processGroup,
  REFS,
  type SseClient,
  startDownloadsApp,
  stopDownloadsApps,
  waitUntil,
} from './downloads-app.ts'
import { makeTempDir, readFakeMedia, readFakeMediaFile } from './helpers.ts'
import { framesOf, readComment, readMp3Tag, readPicture, textOf } from './id3-reader.ts'

// The download pipeline end to end: the real server (routes, queue, attempt, finalize, publish,
// bus, event streams, settings) over HTTP and SSE, with the fake engine replaying recorded runs.
// The harness fails a test whose events break the contract or whose logs hold a URL, a title or a
// path (D18), so every test checks both without saying so.

let root = ''
beforeAll(async () => {
  root = await makeTempDir('downloads')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(stopDownloadsApps)

/** Every status each job went through, from the stream's events. */
function statuses(events: readonly ServerEvent[]): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const note = (id: string, status: string) => {
    const list = seen.get(id) ?? []
    if (list.at(-1) !== status) list.push(status)
    seen.set(id, list)
  }
  for (const event of events) {
    if (event.type === 'jobs.added' || event.type === 'jobs.updated') {
      for (const job of event.jobs) note(job.id, job.status)
    } else if (event.type === 'job.progress') {
      note(event.jobId, 'downloading')
    }
  }
  return seen
}

/** The jobs whose attempts started, in order: each update that took a job from queued to downloading. */
function starts(events: readonly ServerEvent[]): string[] {
  const last = new Map<string, JobStatus>()
  const started: string[] = []
  for (const event of events) {
    if (event.type !== 'jobs.added' && event.type !== 'jobs.updated') continue
    for (const job of event.jobs) {
      if (job.status === 'downloading' && last.get(job.id) === 'queued') started.push(job.id)
      last.set(job.id, job.status)
    }
  }
  return started
}

/** An event as [type, [id, status, cancelRequested?]…], for checking which events a change made. */
function summary(event: ServerEvent): unknown[] {
  switch (event.type) {
    case 'jobs.added':
    case 'jobs.updated':
      return [
        event.type,
        event.jobs.map((job) => [job.id, job.status, ...(job.cancelRequested ? ['cancel'] : [])]),
      ]
    case 'jobs.removed':
      return [event.type, event.ids, event.batchIds]
    default:
      return [event.type]
  }
}

/** Reads the stream until every job in `ids` has finished; resolves with each final Job. */
async function untilSettled(
  sse: SseClient,
  ids: readonly string[],
  ms = 10_000,
): Promise<Map<string, Job>> {
  const settled = new Map<string, Job>()
  const deadline = performance.now() + ms
  for (const event of sse.received) noteSettled(event, ids, settled)
  while (settled.size < ids.length) {
    noteSettled(await sse.next(Math.max(1, deadline - performance.now())), ids, settled)
  }
  return settled
}

function noteSettled(event: ServerEvent, ids: readonly string[], settled: Map<string, Job>): void {
  if (event.type !== 'jobs.added' && event.type !== 'jobs.updated') return
  for (const job of event.jobs) {
    if (ids.includes(job.id) && isTerminalStatus(job.status)) settled.set(job.id, job)
  }
}

/** The job's id at `index` of a response's `jobIds`. */
function idAt(jobIds: readonly string[], index: number): string {
  const id = jobIds[index]
  if (id === undefined) throw new Error(`no job id at ${index}`)
  return id
}

/** The hanging download (youtube-cancel-download) has printed its last line and waits for SIGINT. */
const hung = (job: Job) => job.status === 'downloading' && (job.progress?.percent ?? 0) > 12

async function cancel(app: DownloadsApp, id: string): Promise<Job> {
  const res = await app.post(`/api/downloads/${id}/cancel`)
  expect(res.status).toBe(200)
  return JobSchema.parse(await res.json())
}

describe('downloads', () => {
  it('downloads a YouTube and a SoundCloud track into the folder, tagged, announcing every step', async () => {
    const app = await startDownloadsApp(root)
    const sse = await app.openEvents()
    expect(await sse.next()).toEqual({
      type: 'snapshot',
      serverId: expect.any(String),
      jobs: [],
      batches: [],
      queue: { platforms: [] },
    })
    expect(sse.reconnectMs).toBe(SSE_RETRY_MS)

    const created = await app.download([REFS.youtube, REFS.soundcloud], { label: 'Two tracks' })
    expect(created).toEqual({
      batchId: expect.any(String),
      jobIds: [expect.any(String), expect.any(String)],
      duplicates: 0,
    })
    const [youtubeId, soundcloudId] = created.jobIds
    if (youtubeId === undefined || soundcloudId === undefined) throw new Error('two job ids')

    const added = await sse.until(isEvent('jobs.added'))
    expect(added.batch).toMatchObject({ id: created.batchId, label: 'Two tracks', format: 'mp3' })
    expect(added.jobs.map((job) => [job.id, job.status, job.track])).toEqual([
      [youtubeId, 'queued', REFS.youtube],
      [soundcloudId, 'queued', REFS.soundcloud],
    ])

    const done = await untilSettled(sse, [youtubeId, soundcloudId])
    const progress = sse.received.filter(isEvent('job.progress'))
    for (const id of [youtubeId, soundcloudId]) {
      expect(statuses(sse.received).get(id)).toEqual([
        'queued',
        'downloading',
        'processing',
        'done',
      ])
      expect(progress.some((event) => event.jobId === id)).toBe(true)
    }
    // The HLS download reports its fragments, and the percent only goes up.
    const percents = progress
      .filter((event) => event.jobId === soundcloudId)
      .map((event) => event.progress.percent ?? 0)
    expect(percents).toEqual(percents.toSorted((a, b) => a - b))
    expect(percents.length).toBeGreaterThan(3)

    const youtube = JobSchema.parse(done.get(youtubeId))
    const soundcloud = JobSchema.parse(done.get(soundcloudId))
    expect(youtube).toMatchObject({
      status: 'done',
      folder: app.folder,
      outputPath: path.join(app.folder, 'jawed - Me at the zoo.mp3'),
      // Honest audio: the source as downloaded, the output as written.
      source: { codec: 'opus', bitrateKbps: 106.064 },
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true },
      track: { ...REFS.youtube, title: 'Me at the zoo' },
    })
    expect(soundcloud).toMatchObject({
      status: 'done',
      outputPath: path.join(app.folder, 'The Royal Concept - Knocked Up.mp3'),
      source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true },
      track: { ...REFS.soundcloud, title: 'Knocked Up' },
    })

    // The files, with our ID3v2.3 tag: title, artist, the public page as the comment, the cover.
    expect((await readdir(app.folder)).toSorted()).toEqual([
      'The Royal Concept - Knocked Up.mp3',
      'jawed - Me at the zoo.mp3',
    ])
    const expected = [
      [youtube, 'Me at the zoo', 'jawed', REFS.youtube.url],
      [soundcloud, 'Knocked Up', 'The Royal Concept', REFS.soundcloud.url],
    ] as const
    for (const [job, title, artist, page] of expected) {
      if (job.status !== 'done') throw new Error('done')
      const { tag, audio } = await readMp3Tag(job.outputPath)
      expect(tag.version).toEqual([3, 0])
      expect(textOf(tag, 'TIT2')).toBe(title)
      expect(textOf(tag, 'TPE1')).toBe(artist)
      const comments = framesOf(tag, 'COMM').map(readComment)
      expect(comments).toEqual([{ encoding: 0, language: 'eng', description: '', text: page }])
      const pictures = framesOf(tag, 'APIC').map(readPicture)
      expect(pictures).toHaveLength(1)
      expect(pictures[0]).toMatchObject({ mime: 'image/jpeg', type: 3 })
      // After the tag: the MP3 the (fake) ffmpeg encoded.
      expect(readFakeMedia(audio)).toMatchObject({ kind: 'audio', header: { codec: 'mp3' } })
    }

    // Nothing left behind: no job dirs, no part records.
    expect(await app.jobsLeft()).toEqual([])
    // The folder went to the front of the recent folders.
    expect(app.settings.get().recentFolders).toEqual([app.folder])
    // GET /api/downloads agrees with the stream.
    expect((await app.snapshot()).jobs).toEqual([youtube, soundcloud])
    sse.close()
  })

  it('runs a mixed request: YouTube to MP3, SoundCloud HLS to M4A, a secret link without a comment, and a ref marked preview-only failed at once', async () => {
    const app = await startDownloadsApp(root)
    const sse = await app.openEvents()
    expect(await sse.next()).toMatchObject({ type: 'snapshot', jobs: [] })

    const preview: TrackRef = {
      ...REFS.soundcloudPreview,
      title: 'World on Fire',
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    }
    const mp3 = await app.download([REFS.youtube, REFS.soundcloudSecret, preview])
    const m4a = await app.download([REFS.soundcloud], { format: 'm4a' })
    const youtubeId = idAt(mp3.jobIds, 0)
    const secretId = idAt(mp3.jobIds, 1)
    const previewId = idAt(mp3.jobIds, 2)
    const soundcloudId = idAt(m4a.jobIds, 0)

    // The preview is announced already failed: refused at enqueue, before any slot or spawn.
    const added = await sse.until(isEvent('jobs.added'))
    expect(added.jobs.map((job) => [job.id, job.status])).toEqual([
      [youtubeId, 'queued'],
      [secretId, 'queued'],
      [previewId, 'failed'],
    ])
    expect(added.jobs[2]).toMatchObject({ error: PREVIEW_ONLY, attempt: 1 })
    expect(added.jobs[2]).not.toHaveProperty('startedAt')

    const running = [youtubeId, secretId, soundcloudId]
    const settled = await untilSettled(sse, [...running, previewId])
    const history = statuses(sse.received)
    for (const id of running) {
      expect(history.get(id)).toEqual(['queued', 'downloading', 'processing', 'done'])
      expect(
        sse.received.some((event) => isEvent('job.progress')(event) && event.jobId === id),
      ).toBe(true)
    }
    expect(history.get(previewId)).toEqual(['failed'])
    // yt-dlp ran once per running job, never for the preview.
    const urls = (await app.engine.ytdlp.calls()).map((call) => call.url)
    expect(urls.toSorted()).toEqual(
      [REFS.youtube.url, REFS.soundcloudSecret.url, REFS.soundcloud.url].toSorted(),
    )

    const secretName = "Youtube - Dl Test Video '' Ä↭.mp3"
    expect((await readdir(app.folder)).toSorted()).toEqual(
      ['The Royal Concept - Knocked Up.m4a', 'jawed - Me at the zoo.mp3', secretName].toSorted(),
    )
    const job = (id: string) => {
      const found = settled.get(id)
      if (found?.status !== 'done') throw new Error(`job ${id} is not done`)
      return found
    }

    // YouTube: encoded to MP3 320, the public page in COMM, the cover in APIC.
    expect(job(youtubeId).output).toEqual({
      ext: 'mp3',
      codec: 'mp3',
      bitrateKbps: 320,
      sampleRateHz: 48_000,
      channels: 2,
      encoded: true,
    })
    const youtubeTag = (await readMp3Tag(job(youtubeId).outputPath)).tag
    expect(framesOf(youtubeTag, 'COMM').map(readComment)).toEqual([
      { encoding: 0, language: 'eng', description: '', text: REFS.youtube.url },
    ])
    expect(framesOf(youtubeTag, 'APIC').map(readPicture)).toMatchObject([
      { mime: 'image/jpeg', type: 3 },
    ])

    // The secret link: its MP3 copied at its own 128 kbps, titled, but no comment (a secret link
    // is a credential) and no cover (SoundCloud's default avatar is a placeholder).
    expect(job(secretId)).toMatchObject({
      outputPath: path.join(app.folder, secretName),
      source: { codec: 'mp3', bitrateKbps: 128 },
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 128, encoded: false },
    })
    const secret = await readMp3Tag(job(secretId).outputPath)
    // Tags keep the text as the platform sent it (a combining diaeresis); only the file name is NFC.
    expect(textOf(secret.tag, 'TIT2')).toBe("Dl Test Video '' A\u{308}\u{21ad}")
    expect(textOf(secret.tag, 'TPE1')).toBe('Youtube')
    expect(framesOf(secret.tag, 'COMM')).toEqual([])
    expect(framesOf(secret.tag, 'APIC')).toEqual([])
    expect(readFakeMedia(secret.audio)).toMatchObject({ header: { codec: 'mp3' } })

    // SoundCloud HLS AAC to M4A: the AAC stream copied, tagged by ffmpeg (©cmt = the public page),
    // the artwork as the attached picture.
    expect(job(soundcloudId)).toMatchObject({
      format: 'm4a',
      outputPath: path.join(app.folder, 'The Royal Concept - Knocked Up.m4a'),
      source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
      output: { ext: 'm4a', codec: 'aac', encoded: false },
    })
    expect(await readFakeMediaFile(job(soundcloudId).outputPath)).toMatchObject({
      kind: 'audio',
      header: {
        codec: 'aac',
        tags: { title: 'Knocked Up', artist: 'The Royal Concept', comment: REFS.soundcloud.url },
        cover: true,
      },
    })

    expect(await app.jobsLeft()).toEqual([])
    sse.close()
  })

  it('fails a ref marked preview-only without starting yt-dlp, and a Go+ track that turns out to be a preview as preview_only', async () => {
    const app = await startDownloadsApp(root)
    const marked = await app.download([
      { ...REFS.soundcloudPreview, availability: 'unavailable', unavailableReason: 'preview_only' },
    ])
    const refused = app.queue.get(idAt(marked.jobIds, 0))
    expect(refused).toMatchObject({ status: 'failed', attempt: 1, error: PREVIEW_ONLY })
    expect(refused).not.toHaveProperty('startedAt')
    expect(await app.engine.ytdlp.calls()).toEqual([])

    // The same track unmarked: yt-dlp runs with the break filter, which ends it with exit 101.
    const unmarked = await app.download([REFS.soundcloudPreview])
    expect(unmarked.duplicates).toBe(0)
    const failed = await app.waitForJob(idAt(unmarked.jobIds, 0), 'failed')
    expect(failed).toMatchObject({ error: PREVIEW_ONLY, startedAt: expect.any(String) })
    const calls = await app.engine.ytdlp.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv.join(' ')).toContain('--break-match-filters format_id!*=preview')

    // Retrying failures skips previews: trying again can't make them whole.
    const retried = await app.post('/api/downloads/retry', { target: { scope: 'all' } })
    expect(BulkJobsResponseSchema.parse(await retried.json())).toEqual({ count: 0 })
    expect(await readdir(app.folder)).toEqual([])
    expect(await app.jobsLeft()).toEqual([])
  })
})

describe('cancel', () => {
  it('cancels a queued job at once, and a running one by stopping its process group', async () => {
    const app = await startDownloadsApp(root, { concurrency: 1 })
    const sse = await app.openEvents()
    await sse.next()
    const created = await app.download([REFS.youtubeHang, REFS.youtube])
    const [hangId, queuedId] = [idAt(created.jobIds, 0), idAt(created.jobIds, 1)]
    await app.waitForJob(hangId, hung)
    const [pid] = await app.ytdlpPids()
    if (pid === undefined) throw new Error('yt-dlp started')
    expect(processGroup(pid)).toBe('running')
    const mark = app.events.length

    expect(await cancel(app, queuedId)).toMatchObject({
      id: queuedId,
      status: 'canceled',
      finishedAt: expect.any(String),
    })
    // A running job is asked to stop; it ends canceled once its process group is gone.
    expect(await cancel(app, hangId)).toMatchObject({
      id: hangId,
      status: 'downloading',
      cancelRequested: true,
    })
    const canceled = await app.waitForJob(hangId, 'canceled')
    expect(canceled).toMatchObject({ attempt: 1, cancelRequested: true })
    expect(processGroup(pid)).toBe('gone')
    expect(await app.jobsLeft()).toEqual([])
    expect(await readdir(app.folder)).toEqual([])
    // The queued job never started.
    expect(await app.ytdlpPids()).toEqual([pid])
    expect(app.events.slice(mark).map(summary)).toEqual([
      ['jobs.updated', [[queuedId, 'canceled']]],
      ['jobs.updated', [[hangId, 'downloading', 'cancel']]],
      ['jobs.updated', [[hangId, 'canceled', 'cancel']]],
    ])
    // The stream told the client the same.
    await sse.until(
      (event): event is ServerEvent =>
        event.type === 'jobs.updated' &&
        event.jobs.some((job) => job.id === hangId && job.status === 'canceled'),
    )

    // A finished job stays as it is; an unknown id is not found.
    expect(await cancel(app, hangId)).toEqual(canceled)
    expect(app.events).toHaveLength(mark + 3)
    for (const id of ['0b9a3c1e-4f2d-4a8b-9c7d-1e2f3a4b5c6d', 'not-a-uuid']) {
      const res = await app.post(`/api/downloads/${id}/cancel`)
      expect(res.status).toBe(404)
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('not_found')
    }
    sse.close()
  })

  it("cancels a job in yt-dlp's postprocessing, and one in our ffmpeg pass", async () => {
    const app = await startDownloadsApp(root, { ffmpegEnv: { FAKE_FFMPEG_HANG: 'audio@1' } })

    // youtube-cancel-fixup hangs in FixupM4a, after the download finished: the job is processing.
    const fixup = idAt((await app.download([REFS.youtubeHangInFixup], { format: 'm4a' })).jobIds, 0)
    await app.waitForJob(fixup, 'processing')
    const [ytdlpPid] = await app.ytdlpPids()
    if (ytdlpPid === undefined) throw new Error('yt-dlp started')
    expect(await cancel(app, fixup)).toMatchObject({ status: 'processing', cancelRequested: true })
    await app.waitForJob(fixup, 'canceled')
    expect(processGroup(ytdlpPid)).toBe('gone')
    // Our finalize never started.
    expect(await app.engine.ffmpeg.calls()).toEqual([])

    // The fake ffmpeg hangs in the audio pass (after the cover pass): cancel stops it there.
    const encode = idAt((await app.download([REFS.youtube])).jobIds, 0)
    const audioPass = await waitUntil('the audio pass', async () =>
      (await app.engine.ffmpeg.calls()).find(
        (call) => call.tool === 'ffmpeg' && call.argv.includes('0:a:0'),
      ),
    )
    expect(app.queue.get(encode)?.status).toBe('processing')
    expect(processGroup(audioPass.pid)).toBe('running')
    expect(await cancel(app, encode)).toMatchObject({ status: 'processing', cancelRequested: true })
    await app.waitForJob(encode, 'canceled')
    expect(processGroup(audioPass.pid)).toBe('gone')

    expect(await readdir(app.folder)).toEqual([])
    expect(await app.jobsLeft()).toEqual([])
  })
})

describe('retry', () => {
  it('retries a failed and a canceled job as their second attempt, and refuses to retry a done one', async () => {
    const app = await startDownloadsApp(root, {
      ytdlpRules: [
        { url: REFS.soundcloud.url, stderr: 'errors/network-timeout.log', exit: 1 },
        { url: REFS.youtube.url, download: 'youtube-cancel-download', hangAfter: 3 },
      ],
    })
    const created = await app.download([REFS.soundcloud, REFS.youtube])
    const [failedId, canceledId] = [idAt(created.jobIds, 0), idAt(created.jobIds, 1)]
    const failed = await app.waitForJob(failedId, 'failed')
    expect(failed.error.code).toBe('network')
    await app.waitForJob(canceledId, hung)
    await cancel(app, canceledId)
    await app.waitForJob(canceledId, 'canceled')

    // The platforms answer again.
    app.setYtdlpRules([])
    const mark = app.events.length
    for (const id of [failedId, canceledId]) {
      const res = await app.post(`/api/downloads/${id}/retry`)
      expect(res.status).toBe(200)
      const job = JobSchema.parse(await res.json())
      expect(job).toMatchObject({ id, status: 'queued', attempt: 2 })
      // Nothing of the first attempt is left on it.
      for (const key of ['startedAt', 'source', 'cancelRequested', 'lastError', 'error']) {
        expect(job).not.toHaveProperty(key)
      }
    }
    const [soundcloud, youtube] = await Promise.all([
      app.waitForJob(failedId, ['done', 'failed']),
      app.waitForJob(canceledId, ['done', 'failed']),
    ])
    expect(soundcloud).toMatchObject({ status: 'done', attempt: 2 })
    expect(youtube).toMatchObject({ status: 'done', attempt: 2 })
    const history = statuses(app.events.slice(mark))
    for (const id of [failedId, canceledId]) {
      expect(history.get(id)).toEqual(['queued', 'downloading', 'processing', 'done'])
    }
    expect((await readdir(app.folder)).toSorted()).toEqual([
      'The Royal Concept - Knocked Up.mp3',
      'jawed - Me at the zoo.mp3',
    ])
    expect(await app.ytdlpPids()).toHaveLength(4)

    // A done job has nothing to retry.
    const again = await app.post(`/api/downloads/${failedId}/retry`)
    expect(again.status).toBe(409)
    expect(ApiErrorBodySchema.parse(await again.json())).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Only failed or canceled downloads can be retried.',
      },
    })
    expect(app.queue.get(failedId)).toEqual(soundcloud)
    expect(await app.jobsLeft()).toEqual([])
  })
})

describe('existing files', () => {
  it('skips a track whose file is already in the folder, leaving that file as it was', async () => {
    const app = await startDownloadsApp(root)
    const mine = path.join(app.folder, 'jawed - Me at the zoo.mp3')
    const bytes = Buffer.from('my own edit of this track\n')
    await writeFile(mine, bytes)
    const before = await stat(mine)

    const id = idAt((await app.download([REFS.youtube])).jobIds, 0)
    const job = await app.waitForJob(id, ['done', 'skipped', 'failed'])
    expect(job).toMatchObject({
      status: 'skipped',
      outputPath: mine,
      source: { codec: 'opus', bitrateKbps: 106.064 },
      track: { title: 'Me at the zoo' },
    })
    expect(job).not.toHaveProperty('output')
    expect(statuses(app.events).get(id)).toEqual(['queued', 'downloading', 'processing', 'skipped'])
    expect(await readFile(mine)).toEqual(bytes)
    expect(await stat(mine)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs })
    // No part file or copy of ours beside it.
    expect(await readdir(app.folder)).toEqual(['jawed - Me at the zoo.mp3'])
    expect(await app.jobsLeft()).toEqual([])
  })

  it('treats a name in other letter case as the same file where the volume does (APFS by default)', async () => {
    const app = await startDownloadsApp(root)
    const theirs = 'JAWED - me at the ZOO.MP3'
    const bytes = Buffer.from('the same track, named by hand\n')
    await writeFile(path.join(app.folder, theirs), bytes)
    // Existence is the filesystem's call (D10): ask the volume the way publish does.
    const caseInsensitive = await stat(path.join(app.folder, theirs.toLowerCase())).then(
      () => true,
      () => false,
    )

    const id = idAt((await app.download([REFS.youtube])).jobIds, 0)
    const job = await app.waitForJob(id, ['done', 'skipped', 'failed'])
    const ours = path.join(app.folder, 'jawed - Me at the zoo.mp3')
    if (caseInsensitive) {
      expect(job).toMatchObject({ status: 'skipped', outputPath: ours })
      expect(await readdir(app.folder)).toEqual([theirs])
    } else {
      expect(job).toMatchObject({ status: 'done', outputPath: ours })
      expect((await readdir(app.folder)).toSorted()).toEqual(
        [theirs, path.basename(ours)].toSorted(),
      )
    }
    expect(await readFile(path.join(app.folder, theirs))).toEqual(bytes)
    expect(await app.jobsLeft()).toEqual([])
  })
})

describe('rate limits', () => {
  it('pauses YouTube on a rate limit, puts the job back first with its error, and resumes it after the cooldown', async () => {
    const app = await startDownloadsApp(root, {
      concurrency: 1,
      ytdlpRules: [{ url: REFS.youtube.url, stderr: 'errors/youtube-rate-limited.log', exit: 1 }],
    })
    const at = new Map<ServerEvent, number>()
    app.bus.subscribe((event) => {
      at.set(event, performance.now())
      // YouTube stops limiting once it has paused us (synchronously, before any next spawn).
      if (event.type === 'queue.updated' && event.queue.platforms.length > 0) app.setYtdlpRules([])
    })
    const limitedId = idAt((await app.download([REFS.youtube])).jobIds, 0)
    // Queued behind it, into its own folder (the fixture is the same video, so the same name).
    const other = await app.newFolder('other')
    const behindId = idAt((await app.download([REFS.youtubeNoThumb], { folder: other })).jobIds, 0)

    await app.waitForJob(behindId, 'done')
    const limited = await app.waitForJob(limitedId, 'done')
    expect(limited.attempt).toBe(1)
    // It went first again: the job behind it never started during the pause.
    expect(starts(app.events)).toEqual([limitedId, limitedId, behindId])
    expect(statuses(app.events).get(limitedId)).toEqual([
      'queued',
      'downloading',
      'queued',
      'downloading',
      'processing',
      'done',
    ])

    const requeue = app.events.find(
      (event): event is Extract<ServerEvent, { type: 'jobs.updated' }> =>
        event.type === 'jobs.updated' &&
        event.jobs.some((job) => job.id === limitedId && job.status === 'queued'),
    )
    const requeued = requeue?.jobs.find((job) => job.id === limitedId)
    expect(requeued).toMatchObject({
      status: 'queued',
      attempt: 1,
      lastError: { code: 'rate_limited' },
    })
    expect(requeued).not.toHaveProperty('startedAt')
    const paused = app.events.find(isEvent('queue.updated'))
    expect(paused?.queue).toEqual({
      platforms: [
        { platform: 'youtube', pausedUntil: expect.any(String), pauseCode: 'rate_limited' },
      ],
    })
    // The second attempt waited out the cooldown (200 ms in this harness).
    const restart = app.events.find(
      (event) =>
        event.type === 'jobs.updated' &&
        event.jobs.some((job) => job.id === limitedId && job.status === 'downloading') &&
        app.events.indexOf(event) > app.events.indexOf(requeue ?? event),
    )
    if (requeue === undefined || restart === undefined) throw new Error('a requeue and a restart')
    expect((at.get(restart) ?? 0) - (at.get(requeue) ?? 0)).toBeGreaterThanOrEqual(195)
    // Once the pause is over, the queue says so.
    await waitUntil('the pause to end', () => {
      const last = app.events.findLast(isEvent('queue.updated'))
      return last?.queue.platforms.length === 0
    })
    expect(app.logs.join('\n')).toContain('(rate_limited, strike, 1 own strike)')
  })

  it('fails a job that caused 3 rate-limit strikes itself, with its last error', async () => {
    const app = await startDownloadsApp(root, {
      concurrency: 1,
      cooldown: { baseMs: 100, maxMs: 400 },
    })
    const id = idAt((await app.download([REFS.youtubeRateLimited])).jobIds, 0)
    const failed = await app.waitForJob(id, 'failed')
    expect(failed).toMatchObject({ attempt: 1, error: { code: 'rate_limited' } })
    expect(await app.ytdlpPids()).toHaveLength(3)
    expect(statuses(app.events).get(id)).toEqual([
      'queued',
      'downloading',
      'queued',
      'downloading',
      'queued',
      'downloading',
      'failed',
    ])
    expect(app.events.find(isEvent('queue.updated'))?.queue.platforms).toMatchObject([
      { platform: 'youtube', pauseCode: 'rate_limited' },
    ])
    const logs = app.logs.join('\n')
    expect(logs).toContain('(rate_limited, strike, 1 own strike)')
    expect(logs).toContain('(rate_limited, strike, 2 own strikes)')
    expect(logs).toContain('→ failed (rate_limited)')
  })

  it('fails every queued YouTube job when the bot check outlasts the longest cooldown twice, and nothing else', async () => {
    const app = await startDownloadsApp(root, {
      concurrency: 1,
      cooldown: { baseMs: 100, maxMs: 200 },
    })
    const youtube = await app.download([REFS.youtubeBotCheck, REFS.youtube])
    const [botId, queuedId] = [idAt(youtube.jobIds, 0), idAt(youtube.jobIds, 1)]
    const soundcloudId = idAt((await app.download([REFS.soundcloudSecret])).jobIds, 0)

    const blocked = await app.waitForJob(botId, 'failed')
    expect(blocked.error.code).toBe('bot_check')
    // One update fails both: the bot check and the YouTube job that never got to run.
    const failing = app.events.find(
      (event) =>
        event.type === 'jobs.updated' &&
        event.jobs.some((job) => job.id === botId && job.status === 'failed'),
    )
    expect(failing && summary(failing)).toEqual([
      'jobs.updated',
      [
        [botId, 'failed'],
        [queuedId, 'failed'],
      ],
    ])
    expect(app.queue.get(queuedId)).toMatchObject({ status: 'failed', error: blocked.error })
    // SoundCloud ran during YouTube's pauses.
    expect(await app.waitForJob(soundcloudId, 'done')).toMatchObject({ status: 'done' })
    const urls = (await app.engine.ytdlp.calls()).map((call) => call.url)
    expect(urls.filter((url) => url === REFS.youtubeBotCheck.url)).toHaveLength(3)
    expect(urls).not.toContain(REFS.youtube.url)
    expect(app.logs.join('\n')).toContain('youtube keeps asking for a bot check: failed 1 queued')
  })
})

describe('events', () => {
  it('gives a reconnecting client a fresh snapshot of the current jobs, then the events after it', async () => {
    const app = await startDownloadsApp(root)
    const first = await app.openEvents()
    const initial = await first.next()
    if (initial.type !== 'snapshot') throw new Error('a snapshot first')
    const created = await app.download([REFS.youtubeHang, REFS.soundcloudSecret], {
      label: 'Reconnect',
    })
    const [hangId, doneId] = [idAt(created.jobIds, 0), idAt(created.jobIds, 1)]
    await app.waitForJob(hangId, hung)
    await app.waitForJob(doneId, 'done')

    // The tab goes away: its stream unsubscribes.
    first.close()
    await waitUntil('the stream to close', () => app.streams.size === 0)

    const second = await app.openEvents()
    const snapshot = await second.next()
    expect(second.reconnectMs).toBe(SSE_RETRY_MS)
    expect(snapshot).toEqual({ type: 'snapshot', ...(await app.snapshot()) })
    if (snapshot.type !== 'snapshot') throw new Error('a snapshot first')
    expect(snapshot.serverId).toBe(initial.serverId)
    expect(snapshot.batches).toMatchObject([{ id: created.batchId, label: 'Reconnect' }])
    expect(snapshot.jobs.map((job) => [job.id, job.status])).toEqual([
      [hangId, 'downloading'],
      [doneId, 'done'],
    ])
    // 31,744 of 252,182 bytes.
    expect(snapshot.jobs[0]).toMatchObject({ progress: { percent: expect.closeTo(12.588, 3) } })

    // What happens next comes on the new stream.
    await cancel(app, hangId)
    const asked = await second.next()
    expect(summary(asked)).toEqual(['jobs.updated', [[hangId, 'downloading', 'cancel']]])
    const ended = await second.next()
    expect(summary(ended)).toEqual(['jobs.updated', [[hangId, 'canceled', 'cancel']]])
    second.close()
  })

  it('announces each bulk cancel, retry and clear as one event', async () => {
    const app = await startDownloadsApp(root, { concurrency: 1 })
    const created = await app.download([
      REFS.youtubeHang,
      REFS.youtube,
      REFS.soundcloud,
      REFS.soundcloudSecret,
    ])
    const [hangId, ...queuedIds] = created.jobIds
    if (hangId === undefined) throw new Error('job ids')
    await app.waitForJob(hangId, hung)

    /** POSTs a bulk action; resolves with its count and the events it caused. */
    const bulk = async (route: string, body: unknown) => {
      const mark = app.events.length
      const res = await app.post(route, body)
      expect(res.status).toBe(200)
      const { count } = BulkJobsResponseSchema.parse(await res.json())
      return { count, events: app.events.slice(mark).map(summary) }
    }

    // Cancel the queued three: one update.
    expect(
      await bulk('/api/downloads/cancel', { target: { scope: 'jobs', ids: queuedIds } }),
    ).toEqual({
      count: 3,
      events: [['jobs.updated', queuedIds.map((id) => [id, 'canceled'])]],
    })
    // Retry them: one update, each queued again as its second attempt.
    expect(
      await bulk('/api/downloads/retry', {
        target: { scope: 'batch', batchId: created.batchId },
        statuses: ['canceled'],
      }),
    ).toEqual({ count: 3, events: [['jobs.updated', queuedIds.map((id) => [id, 'queued'])]] })
    expect(queuedIds.map((id) => app.queue.get(id)?.attempt)).toEqual([2, 2, 2])
    // Cancel everything: one update for the four, then the running one's own end.
    const all = await bulk('/api/downloads/cancel', { target: { scope: 'all' } })
    expect(all).toMatchObject({ count: 4 })
    expect(all.events[0]).toEqual([
      'jobs.updated',
      [[hangId, 'downloading', 'cancel'], ...queuedIds.map((id) => [id, 'canceled'])],
    ])
    await app.waitForJob(hangId, 'canceled')
    // Clear them: one removal, the batch with its last job.
    expect(await bulk('/api/downloads/clear', { target: { scope: 'all' } })).toEqual({
      count: 4,
      events: [['jobs.removed', created.jobIds, [created.batchId]]],
    })
    expect(await app.snapshot()).toMatchObject({ jobs: [], batches: [] })
    expect(await app.ytdlpPids()).toHaveLength(1)
  })
})

describe('folders', () => {
  it('fails a job whose folder was renamed before publishing, writing nothing anywhere, and the queued jobs for that folder with it', async () => {
    const app = await startDownloadsApp(root, { concurrency: 1 })
    const other = await app.newFolder('other')
    const created = await app.download([REFS.youtubeHang, REFS.youtube, REFS.soundcloud])
    const hangId = idAt(created.jobIds, 0)
    const renamedId = idAt(created.jobIds, 1)
    const alsoId = idAt(created.jobIds, 2)
    const elsewhere = idAt(
      (await app.download([REFS.soundcloudSecret], { folder: other })).jobIds,
      0,
    )
    await app.waitForJob(hangId, hung)

    // Renamed in Finder while the first job holds the only slot.
    const moved = `${app.folder} (renamed)`
    await rename(app.folder, moved)
    await cancel(app, hangId)
    const failed = await app.waitForJob(renamedId, 'failed')
    expect(failed.error).toEqual({
      code: 'folder_unavailable',
      message:
        'The download folder was moved, renamed or its drive was disconnected. Choose it again.',
    })
    // The job queued for the same folder failed in the same update; the other folder's ran.
    const update = app.events.find(
      (event) =>
        event.type === 'jobs.updated' &&
        event.jobs.some((job) => job.id === renamedId && job.status === 'failed'),
    )
    expect(update && summary(update)).toEqual([
      'jobs.updated',
      [
        [renamedId, 'failed'],
        [alsoId, 'failed'],
      ],
    ])
    expect(app.queue.get(alsoId)).toMatchObject({ error: failed.error })
    await app.waitForJob(elsewhere, 'done')

    // Nothing written: not in the renamed folder, not at the old path (never created again), not
    // in jobs/.
    expect(await readdir(moved)).toEqual([])
    await expect(stat(app.folder)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await app.jobsLeft()).toEqual([])
    expect(await readdir(other)).toEqual(["Youtube - Dl Test Video '' Ä↭.mp3"])
    const urls = (await app.engine.ytdlp.calls()).map((call) => call.url)
    expect(urls).toEqual([REFS.youtubeHang.url, REFS.youtube.url, REFS.soundcloudSecret.url])
  })
})
