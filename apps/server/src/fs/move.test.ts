import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type PartRecord,
  type PublishRequest,
  StepError,
  type TargetFolder,
} from '../jobs/types.ts'
import { createPublish, type PublishOps, streamCopy } from './move.ts'

const errno = (code: string) => Object.assign(new Error(`${code}: /secret/path`), { code })

type Op = keyof PublishOps

/**
 * An in-memory volume: files are path → size. `fail` scripts errno codes per op, one per call in
 * order (undefined = run normally). `on` runs a hook when an op is called, before it acts.
 */
function memoryFs(
  initial: Record<string, number>,
  fail: Partial<Record<Op, (string | undefined)[]>> = {},
  on: Partial<Record<Op, (...args: string[]) => void | Promise<void>>> = {},
) {
  const files = new Map(Object.entries(initial))
  const records = new Map<string, PartRecord[]>()
  const calls: string[] = []
  const realpaths = new Map<string, string>()
  const enter = async (op: Op, ...args: string[]) => {
    calls.push(`${op} ${args.join(' ')}`)
    await on[op]?.(...args)
    const code = fail[op]?.shift()
    if (code !== undefined) throw errno(code)
  }
  const sizeOf = (file: string): number => {
    const size = files.get(file)
    if (size === undefined) throw errno('ENOENT')
    return size
  }
  const sidecar = (file: string) => path.join(path.dirname(file), `._${path.basename(file)}`)
  const ops: PublishOps = {
    link: async (from, to) => {
      await enter('link', from, to)
      if (files.has(to)) throw errno('EEXIST')
      files.set(to, sizeOf(from))
    },
    unlink: async (file) => {
      await enter('unlink', file)
      if (!files.delete(file)) throw errno('ENOENT')
    },
    copyFile: async (from, to, signal) => {
      await enter('copyFile', from, to)
      signal.throwIfAborted()
      if (files.has(to)) throw errno('EEXIST')
      files.set(to, sizeOf(from))
    },
    open: async (file, flags) => {
      await enter('open', file, flags)
      if (files.has(file)) throw errno('EEXIST')
      files.set(file, 0)
      return { close: async () => {} }
    },
    rename: async (from, to) => {
      await enter('rename', from, to)
      files.set(to, sizeOf(from))
      files.delete(from)
      const companion = files.get(sidecar(from))
      if (companion !== undefined) {
        files.set(sidecar(to), companion)
        files.delete(sidecar(from))
      }
    },
    lstat: async (file) => {
      await enter('lstat', file)
      return { size: sizeOf(file) }
    },
    realpath: async (file) => {
      await enter('realpath', file)
      return realpaths.get(file) ?? file
    },
    stat: async (file) => {
      await enter('stat', file)
      return { isDirectory: () => true }
    },
    writeFile: async (file, data, options) => {
      await enter('writeFile', file, String(options.mode.toString(8)))
      const parsed = JSON.parse(data) as PartRecord
      records.set(file, [...(records.get(file) ?? []), parsed])
      files.set(file, data.length)
    },
  }
  return { ops, files, records, calls, realpaths }
}

const ATTEMPT = '0b7d5c2e-1234-4abc-8def-000000000001'
const FOLDER: TargetFolder = { given: '/Volumes/USB/DJ', real: '/Volumes/USB/DJ' }
const SRC = `/data/jobs/${ATTEMPT}/finalize/final.mp3`
const NAME = 'Artist - Title.mp3'
const DEST = path.join(FOLDER.real, NAME)
const PART = path.join(FOLDER.real, `.djs-${ATTEMPT}.part`)
const RECORD = `/data/jobs/${ATTEMPT}.part.json`

const request = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
  src: SRC,
  folder: FOLDER,
  name: NAME,
  attemptId: ATTEMPT,
  jobsDir: '/data/jobs',
  signal: new AbortController().signal,
  ...overrides,
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

/** The rejection reason (or 'resolved') if `promise` settles within `ms`, else 'pending'. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const timeout = new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
  return Promise.race([
    promise.then(
      () => 'resolved',
      (reason: unknown) => reason,
    ),
    timeout,
  ])
}

async function stepError(promise: Promise<unknown>, code: string, message?: string) {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(StepError)
  expect(error).toMatchObject(message === undefined ? { code } : { code, message })
  expect((error as StepError).message).not.toContain('/')
}

describe('createPublish (scripted)', () => {
  describe('same volume', () => {
    it('links the file under its name and removes the job copy', async () => {
      const disk = memoryFs({ [SRC]: 100 })
      await expect(createPublish(disk.ops)(request())).resolves.toEqual({
        status: 'moved',
        path: DEST,
      })
      expect(disk.calls).toEqual([
        `realpath ${FOLDER.given}`,
        `stat ${FOLDER.real}`,
        `link ${SRC} ${DEST}`,
        `unlink ${SRC}`,
      ])
      expect([...disk.files]).toEqual([[DEST, 100]])
      expect(disk.records.size).toBe(0)
    })

    it('reports an existing file (EEXIST) and leaves it alone', async () => {
      const disk = memoryFs({ [SRC]: 100, [DEST]: 7 })
      await expect(createPublish(disk.ops)(request())).resolves.toEqual({
        status: 'exists',
        path: DEST,
      })
      expect(disk.files.get(DEST)).toBe(7)
      expect(
        disk.calls.filter((call) => !call.startsWith('realpath') && !call.startsWith('stat')),
      ).toEqual([`link ${SRC} ${DEST}`])
    })

    it('still moves when unlinking the job copy fails (the job dir goes anyway)', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { unlink: ['EBUSY'] })
      await expect(createPublish(disk.ops)(request())).resolves.toMatchObject({ status: 'moved' })
    })

    it.each([
      ['EROFS', 'folder_unavailable', 'That folder is on a read-only drive.'],
      ['EACCES', 'folder_unavailable', "DJ Scraper isn't allowed to write to that folder."],
      ['ENOSPC', 'disk_full', 'The drive is full. Free some space, then retry.'],
      ['EDQUOT', 'disk_full', 'The drive is full. Free some space, then retry.'],
      ['ENAMETOOLONG', 'unknown', 'The file name is too long for this folder.'],
      ['EIO', 'folder_unavailable', undefined],
    ])('maps link %s to %s', async (code, expected, message) => {
      const disk = memoryFs({ [SRC]: 100 }, { link: [code] })
      await stepError(createPublish(disk.ops)(request()), expected, message)
      expect(disk.files.has(DEST)).toBe(false)
    })

    it('tells a vanished folder (ENOENT, file still there) from a vanished file', async () => {
      const folderGone = memoryFs({ [SRC]: 100 }, { link: ['ENOENT'] })
      await stepError(createPublish(folderGone.ops)(request()), 'folder_unavailable')
      const fileGone = memoryFs({})
      await stepError(
        createPublish(fileGone.ops)(request()),
        'unknown',
        'The finished file disappeared before it could be moved.',
      )
    })
  })

  describe('another volume', () => {
    it('records the part, copies, links it under the name, and cleans up', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV'] })
      await expect(createPublish(disk.ops)(request())).resolves.toEqual({
        status: 'moved',
        path: DEST,
      })
      const steps = disk.calls.filter((call) => !/^(realpath|stat) /.test(call))
      expect(steps).toEqual([
        `link ${SRC} ${DEST}`,
        `writeFile ${RECORD} 600`,
        `copyFile ${SRC} ${PART}`,
        `link ${PART} ${DEST}`,
        `unlink ${PART}`,
        `unlink ${RECORD}`,
      ])
      // The folder is checked again right before the second claim.
      const second = disk.calls.indexOf(`link ${PART} ${DEST}`)
      expect(disk.calls.slice(second - 2, second)).toEqual([
        `realpath ${FOLDER.given}`,
        `stat ${FOLDER.real}`,
      ])
      expect(disk.records.get(RECORD)).toEqual([{ partPath: PART }])
      expect([...disk.files.keys()].sort()).toEqual([DEST, SRC])
    })

    it('reports an existing file at the second claim and removes the part', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV', 'EEXIST'] })
      await expect(createPublish(disk.ops)(request())).resolves.toEqual({
        status: 'exists',
        path: DEST,
      })
      expect(disk.files.has(PART)).toBe(false)
      expect(disk.files.has(RECORD)).toBe(false)
    })

    it.each(['EPERM', 'EMLINK', 'ENOTSUP'])(
      'copies when the first link fails with %s',
      async (code) => {
        const disk = memoryFs({ [SRC]: 100 }, { link: [code] })
        await expect(createPublish(disk.ops)(request())).resolves.toMatchObject({ status: 'moved' })
        expect(disk.calls).toContain(`copyFile ${SRC} ${PART}`)
      },
    )

    it.each([
      ['exFAT/FAT (ENOTSUP)', 'ENOTSUP'],
      ['SMB (EPERM)', 'EPERM'],
    ])(
      'on %s: reserves the name, then renames the part onto the placeholder',
      async (_label, code) => {
        const disk = memoryFs({ [SRC]: 100 }, { link: [code, code] })
        await expect(createPublish(disk.ops)(request())).resolves.toEqual({
          status: 'moved',
          path: DEST,
        })
        const steps = disk.calls.filter((call) => !/^(realpath|stat) /.test(call))
        expect(steps).toEqual([
          `link ${SRC} ${DEST}`,
          `writeFile ${RECORD} 600`,
          `copyFile ${SRC} ${PART}`,
          `link ${PART} ${DEST}`,
          `open ${DEST} wx`,
          `writeFile ${RECORD} 600`,
          `lstat ${path.join(FOLDER.real, `._.djs-${ATTEMPT}.part`)}`,
          `rename ${PART} ${DEST}`,
          `unlink ${RECORD}`,
        ])
        expect(disk.records.get(RECORD)).toEqual([
          { partPath: PART },
          { partPath: PART, placeholderPath: DEST },
        ])
        expect(disk.files.get(DEST)).toBe(100)
      },
    )

    it('reports a name taken between the link and the reservation, keeping that file', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV', 'ENOTSUP'], open: ['EEXIST'] })
      await expect(createPublish(disk.ops)(request())).resolves.toEqual({
        status: 'exists',
        path: DEST,
      })
      expect(disk.files.has(PART)).toBe(false)
      expect(disk.calls).not.toContain(`rename ${PART} ${DEST}`)
    })

    it("removes our part's sidecar after the rename (it follows the file), and only that one", async () => {
      const partSidecar = path.join(FOLDER.real, `._.djs-${ATTEMPT}.part`)
      const destSidecar = path.join(FOLDER.real, `._${NAME}`)
      const disk = memoryFs({ [SRC]: 100, [partSidecar]: 4096 }, { link: ['EXDEV', 'ENOTSUP'] })
      await createPublish(disk.ops)(request())
      expect(disk.calls).toContain(`unlink ${destSidecar}`)
      expect(disk.files.has(destSidecar)).toBe(false)
      expect(disk.files.has(partSidecar)).toBe(false)

      // No sidecar of ours before the rename: a `._<name>` there isn't touched.
      const other = memoryFs({ [SRC]: 100, [destSidecar]: 4096 }, { link: ['EXDEV', 'ENOTSUP'] })
      await createPublish(other.ops)(request())
      expect(other.calls).not.toContain(`unlink ${destSidecar}`)
      expect(other.files.get(destSidecar)).toBe(4096)
    })

    it('fails with disk_full when the copy runs out of space, leaving nothing behind', async () => {
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        {
          copyFile: (_from, to) => {
            disk.files.set(to, 50) // the copy got halfway
            throw errno('ENOSPC')
          },
        },
      )
      await stepError(createPublish(disk.ops)(request()), 'disk_full')
      expect([...disk.files.keys()]).toEqual([SRC])
      expect(disk.calls).not.toContain(`link ${PART} ${DEST}`)
    })

    it('fails when the record cannot be written, before copying anything', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV'], writeFile: ['ENOSPC'] })
      await stepError(createPublish(disk.ops)(request()), 'disk_full')
      expect(disk.calls.some((call) => call.startsWith('copyFile'))).toBe(false)
    })

    it('removes the part and our empty placeholder when the rename fails', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV', 'ENOTSUP'], rename: ['EIO'] })
      await stepError(
        createPublish(disk.ops)(request()),
        'folder_unavailable',
        "The folder's drive stopped responding. Check that it is connected, then retry.",
      )
      expect([...disk.files.keys()]).toEqual([SRC])
    })

    it("leaves a placeholder that is no longer empty: it isn't ours any more", async () => {
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV', 'ENOTSUP'], rename: ['EIO'] },
        { rename: (_from, to) => void disk.files.set(to, 5) },
      )
      await stepError(createPublish(disk.ops)(request()), 'folder_unavailable')
      expect(disk.files.get(DEST)).toBe(5)
      expect(disk.files.has(PART)).toBe(false)
      // Nor is it the sweep's to remove.
      expect(disk.files.has(RECORD)).toBe(false)
    })

    it('keeps the record when the part cannot be removed', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV', 'EIO'], unlink: ['EIO'] })
      await stepError(createPublish(disk.ops)(request()), 'folder_unavailable')
      expect(disk.files.has(PART)).toBe(true)
      expect(disk.files.has(RECORD)).toBe(true)
    })

    it.each([
      ['the drive is unplugged: keeps the record for the sweep', true],
      ['the folder is still there: the part is gone, and so is the record', false],
    ])('when the copy fails and its part is missing, and %s', async (_label, unplugged) => {
      let gone = false
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        {
          copyFile: () => {
            gone = unplugged
            throw errno('ENXIO')
          },
          stat: (file) => {
            if (gone && file === FOLDER.real) throw errno('ENOENT')
          },
        },
      )
      await stepError(createPublish(disk.ops)(request()), 'folder_unavailable')
      expect(disk.files.has(RECORD)).toBe(unplugged)
    })

    it('removes our placeholder when closing it fails', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { link: ['EXDEV', 'ENOTSUP'] })
      const publish = createPublish({
        ...disk.ops,
        open: async (file, flags) => {
          await disk.ops.open(file, flags)
          return { close: () => Promise.reject(errno('EIO')) }
        },
      })
      await stepError(publish(request()), 'folder_unavailable')
      expect([...disk.files.keys()]).toEqual([SRC])
    })
  })

  describe('the folder check', () => {
    it('fails without writing when the folder no longer resolves to the same place', async () => {
      const disk = memoryFs({ [SRC]: 100 })
      disk.realpaths.set(FOLDER.given, '/Volumes/USB 1/DJ')
      await stepError(
        createPublish(disk.ops)(request()),
        'folder_unavailable',
        'The download folder was moved, renamed or its drive was disconnected. Choose it again.',
      )
      expect(disk.calls.some((call) => call.startsWith('link'))).toBe(false)
    })

    it('checks again before the cross-volume claim, and removes the part when it fails', async () => {
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        { copyFile: () => void disk.realpaths.set(FOLDER.given, '/elsewhere') },
      )
      await stepError(createPublish(disk.ops)(request()), 'folder_unavailable')
      expect([...disk.files.keys()]).toEqual([SRC])
      expect(disk.calls).not.toContain(`link ${PART} ${DEST}`)
    })

    it('fails when the folder is gone (ENOENT), never creating it', async () => {
      const disk = memoryFs({ [SRC]: 100 }, { realpath: ['ENOENT'] })
      await stepError(createPublish(disk.ops)(request()), 'folder_unavailable')
      expect(disk.calls.some((call) => /^(link|open|copyFile|writeFile)/.test(call))).toBe(false)
    })
  })

  describe('abort', () => {
    const reason = { kind: 'cancel' }

    it('rejects with the reason before doing anything when already aborted', async () => {
      const controller = new AbortController()
      controller.abort(reason)
      const disk = memoryFs({ [SRC]: 100 })
      await expect(createPublish(disk.ops)(request({ signal: controller.signal }))).rejects.toBe(
        reason,
      )
      expect(disk.calls).toEqual([])
    })

    it('stops the copy, removes the part and the record, and rejects with the reason', async () => {
      const controller = new AbortController()
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        {
          copyFile: (_from, to) => {
            disk.files.set(to, 10)
            controller.abort(reason)
          },
        },
      )
      await expect(createPublish(disk.ops)(request({ signal: controller.signal }))).rejects.toBe(
        reason,
      )
      expect([...disk.files.keys()]).toEqual([SRC])
      expect(disk.calls).not.toContain(`link ${PART} ${DEST}`)
    })

    it('does not start the claim after an abort that came in during the copy', async () => {
      const controller = new AbortController()
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        {
          // The copy itself finishes, then the abort arrives.
          unlink: () => {},
        },
      )
      const publish = createPublish({
        ...disk.ops,
        copyFile: async (from, to, signal) => {
          await disk.ops.copyFile(from, to, signal)
          controller.abort(reason)
        },
      })
      await expect(publish(request({ signal: controller.signal }))).rejects.toBe(reason)
      expect(disk.files.has(DEST)).toBe(false)
      expect(disk.files.has(PART)).toBe(false)
    })

    it('finishes a claim that has started: the file is published', async () => {
      const controller = new AbortController()
      const disk = memoryFs({ [SRC]: 100 }, {}, { link: () => controller.abort(reason) })
      await expect(
        createPublish(disk.ops)(request({ signal: controller.signal })),
      ).resolves.toEqual({ status: 'moved', path: DEST })
    })

    it('does not claim after an abort that came in during the folder check', async () => {
      const controller = new AbortController()
      const disk = memoryFs({ [SRC]: 100 }, {}, { stat: () => controller.abort(reason) })
      await expect(createPublish(disk.ops)(request({ signal: controller.signal }))).rejects.toBe(
        reason,
      )
      expect(disk.calls.some((call) => call.startsWith('link'))).toBe(false)
      expect([...disk.files.keys()]).toEqual([SRC])
    })

    it('does not claim across volumes after an abort during the second folder check', async () => {
      const controller = new AbortController()
      let checks = 0
      const disk = memoryFs(
        { [SRC]: 100 },
        { link: ['EXDEV'] },
        {
          stat: () => {
            if (++checks === 2) controller.abort(reason)
          },
        },
      )
      await expect(createPublish(disk.ops)(request({ signal: controller.signal }))).rejects.toBe(
        reason,
      )
      expect(disk.calls).not.toContain(`link ${PART} ${DEST}`)
      expect([...disk.files.keys()]).toEqual([SRC])
    })

    it('stops waiting for the claim lock at once, and the claims after it keep their order', async () => {
      let release: () => void = () => {}
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const second = SRC.replace('final', 'second')
      const third = SRC.replace('final', 'third')
      const disk = memoryFs(
        { [SRC]: 100, [second]: 50, [third]: 30 },
        {},
        {
          link: async (from) => {
            if (from === SRC) await blocked
          },
        },
      )
      const publish = createPublish(disk.ops)
      const controller = new AbortController()
      try {
        const first = publish(request())
        const waiting = publish(
          request({
            src: second,
            attemptId: randomUUID(),
            name: 'Second.mp3',
            signal: controller.signal,
          }),
        )
        const after = publish(request({ src: third, attemptId: randomUUID(), name: 'Third.mp3' }))
        await new Promise((resolve) => setTimeout(resolve, 20))
        controller.abort(reason)
        // While the first claim still holds the lock.
        expect(await settledWithin(waiting, 50)).toBe(reason)
        expect(disk.calls.filter((call) => call.startsWith('realpath'))).toHaveLength(1)
        release()
        await expect(first).resolves.toMatchObject({ status: 'moved' })
        await expect(after).resolves.toMatchObject({ status: 'moved' })
        expect(disk.calls.some((call) => call.includes(second))).toBe(false)
        // The third claim ran after the first one's link, never beside it.
        const firstLink = disk.calls.indexOf(`link ${SRC} ${DEST}`)
        expect(disk.calls.lastIndexOf(`realpath ${FOLDER.given}`)).toBeGreaterThan(firstLink)
      } finally {
        // The lock is module-wide: never leave it held for the tests after this one.
        release()
      }
    })
  })

  it.each([
    ['an empty name', { name: '' }],
    ['a dot', { name: '.' }],
    ['a dot-dot', { name: '..' }],
    ['a path', { name: 'sub/x.mp3' }],
    ['a NUL', { name: 'x\u{0}.mp3' }],
    ['an attempt id that is no UUID', { attemptId: '../x' }],
  ])('refuses %s', async (_label, overrides) => {
    const disk = memoryFs({ [SRC]: 100 })
    await stepError(createPublish(disk.ops)(request(overrides)), 'unknown')
    expect(disk.calls).toEqual([])
  })

  it('runs one claim at a time across publishes (the folder check and link together)', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const otherSrc = SRC.replace('final', 'other')
    const disk = memoryFs(
      { [SRC]: 100, [otherSrc]: 50 },
      {},
      {
        link: async (from) => {
          if (from === SRC) await blocked
        },
      },
    )
    const publish = createPublish(disk.ops)
    const first = publish(request())
    const second = publish(request({ src: otherSrc, attemptId: randomUUID(), name: 'Other.mp3' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The second claim hasn't even checked the folder while the first one holds the lock.
    expect(disk.calls.filter((call) => call.startsWith('realpath'))).toHaveLength(1)
    release()
    await expect(first).resolves.toMatchObject({ status: 'moved' })
    await expect(second).resolves.toMatchObject({ status: 'moved' })
    const firstLink = disk.calls.indexOf(`link ${SRC} ${DEST}`)
    expect(disk.calls.lastIndexOf(`realpath ${FOLDER.given}`)).toBeGreaterThan(firstLink)
  })

  it('releases the lock after a failed claim', async () => {
    const disk = memoryFs({ [SRC]: 100 }, { link: ['EROFS'] })
    const publish = createPublish(disk.ops)
    await stepError(publish(request()), 'folder_unavailable')
    await expect(publish(request())).resolves.toMatchObject({ status: 'moved' })
  })
})

describe('createPublish (real files)', () => {
  let root: string
  let jobsDir: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-move-')))
    jobsDir = path.join(root, 'data', 'jobs')
    await mkdir(jobsDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** A finished file in a fresh job dir, and a fresh target folder. */
  async function setup(content: string | Uint8Array = 'NEW AUDIO') {
    const attemptId = randomUUID()
    const jobDir = path.join(jobsDir, attemptId)
    await mkdir(jobDir)
    const src = path.join(jobDir, 'final.mp3')
    await writeFile(src, content)
    const dir = path.join(root, `music-${attemptId.slice(0, 8)}`)
    await mkdir(dir)
    const folder: TargetFolder = { given: dir, real: dir }
    const publishRequest = (
      name: string,
      signal = new AbortController().signal,
    ): PublishRequest => ({
      src,
      folder,
      name,
      attemptId,
      jobsDir,
      signal,
    })
    return { attemptId, src, dir, folder, publishRequest }
  }

  it('moves the file into the folder', async () => {
    const { src, dir, publishRequest } = await setup()
    await expect(createPublish()(publishRequest('Artist - Title.mp3'))).resolves.toEqual({
      status: 'moved',
      path: path.join(dir, 'Artist - Title.mp3'),
    })
    expect(await readFile(path.join(dir, 'Artist - Title.mp3'), 'utf8')).toBe('NEW AUDIO')
    await expect(readFile(src)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("never touches a user's file of the same name", async () => {
    const { src, dir, publishRequest } = await setup()
    const user = Uint8Array.from([0x49, 0x44, 0x33, 0, 1, 2, 3])
    await writeFile(path.join(dir, 'Artist - Title.mp3'), user)
    await expect(createPublish()(publishRequest('Artist - Title.mp3'))).resolves.toMatchObject({
      status: 'exists',
    })
    expect(new Uint8Array(await readFile(path.join(dir, 'Artist - Title.mp3')))).toEqual(user)
    expect(await readFile(src, 'utf8')).toBe('NEW AUDIO')
  })

  it('treats a name in another case or Unicode form as existing (APFS is insensitive)', async ({
    skip,
  }) => {
    const { dir, publishRequest } = await setup()
    await writeFile(path.join(dir, 'Café - B.mp3'), 'USER')
    const probe = await readFile(path.join(dir, 'CAFÉ - B.MP3')).then(
      () => true,
      () => false,
    )
    if (!probe) skip()
    const publish = createPublish()
    await expect(publish(publishRequest('café - b.mp3'))).resolves.toMatchObject({
      status: 'exists',
    })
    await expect(publish(publishRequest('Cafe\u{301} - B.mp3'))).resolves.toMatchObject({
      status: 'exists',
    })
    expect(await readdir(dir)).toEqual(['Café - B.mp3'])
    expect(await readFile(path.join(dir, 'Café - B.mp3'), 'utf8')).toBe('USER')
  })

  it('fails with folder_unavailable when the folder was renamed, writing nothing', async () => {
    const { dir, publishRequest } = await setup()
    await rename(dir, `${dir}-renamed`)
    const error = await rejection(createPublish()(publishRequest('Artist - Title.mp3')))
    expect(error).toMatchObject({ code: 'folder_unavailable' })
    expect(await readdir(`${dir}-renamed`)).toEqual([])
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies across volumes (EXDEV): fsynced part, linked, nothing left behind', async () => {
    const { attemptId, dir, publishRequest } = await setup('A'.repeat(300_000))
    let first = true
    const publish = createPublish({
      link: async (from, to) => {
        if (first) {
          first = false
          throw errno('EXDEV')
        }
        const { link } = await import('node:fs/promises')
        await link(from, to)
      },
    })
    await expect(publish(publishRequest('Cross.mp3'))).resolves.toMatchObject({ status: 'moved' })
    expect(await readFile(path.join(dir, 'Cross.mp3'), 'utf8')).toBe('A'.repeat(300_000))
    expect(await readdir(dir)).toEqual(['Cross.mp3'])
    expect(await readdir(jobsDir)).not.toContain(`${attemptId}.part.json`)
  })

  it('keeps the part record when the folder is renamed during the copy', async () => {
    const { attemptId, dir, publishRequest } = await setup('B'.repeat(100_000))
    const publish = createPublish({
      link: () => Promise.reject(errno('EXDEV')),
      copyFile: async (from, to, signal) => {
        await streamCopy(from, to, signal)
        await rename(dir, `${dir}-renamed`)
      },
    })
    const error = await rejection(publish(publishRequest('Moved.mp3')))
    expect(error).toMatchObject({ code: 'folder_unavailable' })
    // The part went with the folder; the record still names it, for the startup sweep.
    expect(await readdir(`${dir}-renamed`)).toEqual([`.djs-${attemptId}.part`])
    const record = path.join(jobsDir, `${attemptId}.part.json`)
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      partPath: path.join(dir, `.djs-${attemptId}.part`),
    } satisfies PartRecord)
  })

  it('emulates FAT (no hard links at all): reserve, rename, existing names kept', async () => {
    const { dir, publishRequest } = await setup('FAT AUDIO')
    const noLinks = createPublish({ link: () => Promise.reject(errno('ENOTSUP')) })
    await expect(noLinks(publishRequest('Fat.mp3'))).resolves.toMatchObject({ status: 'moved' })
    expect(await readFile(path.join(dir, 'Fat.mp3'), 'utf8')).toBe('FAT AUDIO')
    expect(await readdir(dir)).toEqual(['Fat.mp3'])

    const again = await setup('SECOND')
    await writeFile(path.join(again.dir, 'Fat.mp3'), 'USER')
    await expect(noLinks(again.publishRequest('Fat.mp3'))).resolves.toMatchObject({
      status: 'exists',
    })
    expect(await readFile(path.join(again.dir, 'Fat.mp3'), 'utf8')).toBe('USER')
    expect(await readdir(again.dir)).toEqual(['Fat.mp3'])
  })

  it('aborts a real stream copy and removes the part', async () => {
    const { dir, publishRequest } = await setup(new Uint8Array(32 * 1024 * 1024))
    const controller = new AbortController()
    const reason = { kind: 'shutdown' }
    const publish = createPublish({
      link: () => Promise.reject(errno('EXDEV')),
      copyFile: (from, to, signal) => {
        const copying = streamCopy(from, to, signal)
        setImmediate(() => controller.abort(reason))
        return copying
      },
    })
    await expect(publish(publishRequest('Big.mp3', controller.signal))).rejects.toBe(reason)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('streamCopy', () => {
  it('refuses to write over an existing file', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-copy-')))
    try {
      await writeFile(path.join(dir, 'src'), 'NEW')
      await writeFile(path.join(dir, 'dest'), 'OLD')
      await expect(
        streamCopy(path.join(dir, 'src'), path.join(dir, 'dest'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(path.join(dir, 'dest'), 'utf8')).toBe('OLD')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
