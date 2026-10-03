import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DataDirError,
  type DataDirLock,
  DataDirLocked,
  leftoverGroups,
  lockDataDir,
  parsePs,
  prepareDataDir,
  type SweepDeps,
  sweepLeftovers,
} from './data-dir.ts'
import type { RunResult, run } from './engine/run.ts'
import { createPublish } from './fs/move.ts'
import type { PartRecord, TargetFolder } from './jobs/types.ts'

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const mode = async (file: string) => (await stat(file)).mode & 0o777

let root = ''
const locks: DataDirLock[] = []
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-data-dir-')))
})
afterEach(async () => {
  for (const lock of locks.splice(0)) lock.release()
  await rm(root, { recursive: true, force: true })
})

describe('parsePs', () => {
  it.each([
    ['    1     1 /sbin/launchd', [{ pid: 1, pgid: 1, command: '/sbin/launchd' }]],
    [
      '67858 67858 /opt/homebrew/bin/yt-dlp --ignore-config -P /a b/jobs/x',
      [
        {
          pid: 67858,
          pgid: 67858,
          command: '/opt/homebrew/bin/yt-dlp --ignore-config -P /a b/jobs/x',
        },
      ],
    ],
    ['  104  6302 <defunct>', [{ pid: 104, pgid: 6302, command: '<defunct>' }]],
    ['  105  105', [{ pid: 105, pgid: 105, command: '' }]],
    [
      '  106   106 /Users/José/Library/x é 🎵',
      [{ pid: 106, pgid: 106, command: '/Users/José/Library/x é 🎵' }],
    ],
    ['', []],
    ['PID PGID COMMAND', []],
    ['  12 abc /bin/sh', []],
    ['99999999999999999999 1 x', []],
  ])('%j', (line, rows) => {
    expect(parsePs(line)).toEqual(rows)
  })

  it('reads every line of a listing', () => {
    expect(parsePs('  1  1 a\n  2  1 b\r\n\n  3  3 c').map((row) => row.pid)).toEqual([1, 2, 3])
  })
})

describe('leftoverGroups', () => {
  const data = '/Users/dj/Library/Application Support/DJ Scraper'
  const marker = `${data}/jobs/`
  const job = `${marker}${testUuid(7)}`
  const row = (pid: number, pgid: number, command: string) => ({ pid, pgid, command })

  it.each([
    ['yt-dlp -P <job dir> (the end of the line)', `python yt-dlp -P ${job}`, true],
    ['yt-dlp -P <job dir> -o …', `python yt-dlp -P ${job} -o %(id)s.%(ext)s`, true],
    [
      'ffmpeg -i file:<job dir>/<file>',
      `ffmpeg -y -i file:${job}/x.webm -vn file:${job}/x.mp3`,
      true,
    ],
    ['an option with =', `ffmpeg --out=${job}/out.mp3`, true],
    ['a quoted path', `sh -c "${job}/x"`, true],
    ['the marker without a UUID', `python yt-dlp -P ${marker}settings`, false],
    [
      'an upper-case UUID (ours are lower-case)',
      `x ${marker}${testUuid(0xabcdef).toUpperCase()}`,
      false,
    ],
    ['a UUID followed by more name', `x ${job}.part.json`, false],
    ['a UUID too short', `x ${marker}${testUuid(7).slice(0, -1)}`, false],
    ['another data dir that ends like ours', `x /Volumes/Backup${job}`, false],
    ['the data dir without jobs/', `x ${data}/${testUuid(7)}`, false],
    ['nothing', '/sbin/launchd', false],
  ])('%s → %s', (_name, command, matches) => {
    expect(leftoverGroups([row(500, 400, command)], marker, 1)).toEqual(matches ? [400] : [])
  })

  it('finds the marker at the start of a command, and after an earlier non-match', () => {
    expect(leftoverGroups([row(5, 5, `${job}/run`)], marker, 1)).toEqual([5])
    expect(leftoverGroups([row(5, 5, `x /X${job} -P ${job}`)], marker, 1)).toEqual([5])
  })

  it('lists each group once, never ours, never group 0 or 1', () => {
    const command = `yt-dlp -P ${job}`
    const rows = [
      row(10, 10, command),
      row(11, 10, `ffmpeg -i file:${job}/a`),
      row(12, 12, 'deno run'),
      row(20, 20, command),
      row(30, 30, command),
      row(31, 1, command),
      row(32, 0, command),
    ]
    expect(leftoverGroups(rows, marker, 30)).toEqual([10, 20])
  })
})

describe('prepareDataDir', () => {
  it('creates the data dir and its jobs folder as 0700, and returns its real path', async () => {
    const given = path.join(root, 'a', 'DJ Scraper')
    const real = await prepareDataDir(given)
    expect(real).toBe(given)
    expect(await mode(given)).toBe(0o700)
    expect(await mode(path.join(given, 'jobs'))).toBe(0o700)
  })

  it('returns the real path through a symlinked parent', async () => {
    await mkdir(path.join(root, 'real'))
    await symlink(path.join(root, 'real'), path.join(root, 'link'))
    expect(await prepareDataDir(path.join(root, 'link', 'data'))).toBe(
      path.join(root, 'real', 'data'),
    )
  })

  it("leaves the permissions of an existing folder that isn't ours yet", async () => {
    const dir = path.join(root, 'existing')
    await mkdir(dir)
    await chmod(dir, 0o755)
    await prepareDataDir(dir)
    expect(await mode(dir)).toBe(0o755)
    expect(await mode(path.join(dir, 'jobs'))).toBe(0o700)
  })

  it('tightens an existing data dir that holds server.lock, and its jobs folder', async () => {
    const dir = path.join(root, 'ours')
    await mkdir(path.join(dir, 'jobs'), { recursive: true })
    await writeFile(path.join(dir, 'server.lock'), '{}')
    await chmod(dir, 0o755)
    await chmod(path.join(dir, 'jobs'), 0o755)
    await prepareDataDir(dir)
    expect(await mode(dir)).toBe(0o700)
    expect(await mode(path.join(dir, 'jobs'))).toBe(0o700)
  })

  it.each([
    ['a symlink', async (dir: string) => symlink(root, dir), /symbolic link/],
    ['a file', async (dir: string) => writeFile(dir, 'x'), /not a folder/],
    [
      'a jobs symlink',
      async (dir: string) => {
        await mkdir(dir)
        await symlink(root, path.join(dir, 'jobs'))
      },
      /jobs folder is a symbolic link/,
    ],
    [
      'a jobs file',
      async (dir: string) => {
        await mkdir(dir)
        await writeFile(path.join(dir, 'jobs'), '')
      },
      /jobs folder is not a folder/,
    ],
  ])('refuses %s, without a path in the message', async (_name, make, message) => {
    const dir = path.join(root, 'bad')
    await make(dir)
    const error = await prepareDataDir(dir).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDirError)
    expect(error).toMatchObject({ message: expect.stringMatching(message), dataDir: dir })
    expect((error as Error).message).not.toContain(root)
  })

  it('refuses a data dir that belongs to another user', async () => {
    await mkdir(path.join(root, 'theirs'))
    const uid = (process.getuid?.() ?? 0) + 1
    await expect(prepareDataDir(path.join(root, 'theirs'), { uid })).rejects.toThrow(
      /belongs to another user/,
    )
  })

  it('reports a folder it cannot create by its code', async () => {
    await mkdir(path.join(root, 'locked'))
    await chmod(path.join(root, 'locked'), 0o500)
    try {
      await expect(prepareDataDir(path.join(root, 'locked', 'data'))).rejects.toThrow(
        "The app data folder can't be created (EACCES)",
      )
    } finally {
      await chmod(path.join(root, 'locked'), 0o700)
    }
  })
})

describe('lockDataDir', () => {
  const lock = async (options: Parameters<typeof lockDataDir>[1] = {}) => {
    const taken = await lockDataDir(root, { log: log(), ...options })
    locks.push(taken)
    return taken
  }
  const record = async () => JSON.parse(await readFile(path.join(root, 'server.lock'), 'utf8'))

  it('takes the lock and records who holds it, then the port once listening', async () => {
    const taken = await lock({ pid: 4242, now: () => Date.UTC(2026, 9, 2, 8) })
    expect(taken.exclusive).toBe(true)
    expect(await record()).toEqual({ pid: 4242, startedAt: '2026-10-02T08:00:00.000Z' })
    expect(await mode(path.join(root, 'server.lock'))).toBe(0o600)
    taken.setPort(4747)
    expect(await record()).toEqual({ pid: 4242, startedAt: '2026-10-02T08:00:00.000Z', port: 4747 })
    taken.setPort(5)
    expect(await record()).toMatchObject({ port: 5 })
  })

  it('waits for a holder, then names it', async () => {
    const first = await lock({ pid: 4242 })
    first.setPort(4747)
    const sleeps: number[] = []
    const logger = log()
    const error = await lockDataDir(root, {
      waitMs: 1000,
      pollMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log: logger,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDirLocked)
    expect(error).toMatchObject({
      holder: { pid: 4242, port: 4747 },
      message:
        'Another DJ Scraper server (pid 4242, http://127.0.0.1:4747/) is using the app data folder',
    })
    expect(sleeps).toEqual([250, 250, 250, 250])
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      '[server] Waiting for the previous server (pid 4242) to stop…',
    )
  })

  it('gets the lock once the holder lets go while it waits', async () => {
    const first = await lock()
    const second = await lock({
      sleep: async () => {
        first.release()
      },
    })
    expect(second.exclusive).toBe(true)
    expect(await record()).toMatchObject({ pid: process.pid })
  })

  it('names no holder whose record it cannot read', async () => {
    const first = await lock()
    await writeFile(path.join(root, 'server.lock'), 'not json')
    const error = await lock({ waitMs: 0 }).catch((e: unknown) => e)
    expect(error).toMatchObject({
      holder: undefined,
      message: 'Another DJ Scraper server is using the app data folder',
    })
    first.release()
  })

  it('lets the next server in after release, and releases once', async () => {
    const first = await lock()
    first.release()
    first.release()
    first.setPort(1)
    const second = await lock({ waitMs: 0 })
    expect(second.exclusive).toBe(true)
    expect(await record()).not.toHaveProperty('port')
  })

  it.each(['ENOTSUP', 'EOPNOTSUPP'])(
    'runs without the lock (and without the sweep) on a filesystem that says %s',
    async (code) => {
      const logger = log()
      const taken = await lock({
        log: logger,
        open: () => {
          throw Object.assign(new Error(`${code}: /x/server.lock`), { code })
        },
      })
      expect(taken.exclusive).toBe(false)
      taken.setPort(1)
      taken.release()
      expect(logger.warn.mock.calls[0]?.[0]).toMatch(new RegExp(`\\(${code}\\)`))
    },
  )

  it('runs without the lock outside macOS', async () => {
    const taken = await lock({ platform: 'linux' })
    expect(taken.exclusive).toBe(false)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses a server.lock that is a symlink, leaving the file it points to alone', async () => {
    const target = path.join(root, 'notes.txt')
    await writeFile(target, 'the user’s notes')
    await symlink(target, path.join(root, 'server.lock'))
    await expect(lock()).rejects.toThrow(
      new DataDirError("The app data folder can't be locked (ELOOP)", root),
    )
    expect(await readFile(target, 'utf8')).toBe('the user’s notes')
  })

  it('reports another open error by its code', async () => {
    await expect(
      lock({
        open: () => {
          throw Object.assign(new Error('EACCES: /x'), { code: 'EACCES' })
        },
      }),
    ).rejects.toThrow(new DataDirError("The app data folder can't be locked (EACCES)", root))
  })
})

describe('sweepLeftovers', () => {
  const ME = 70_000
  const psOut = (lines: string[]) =>
    ({
      pid: 1,
      exitCode: 0,
      signal: null,
      stdout: lines.join('\n'),
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 60,
    }) satisfies RunResult

  /** A ps that lists `lines` (plus this server), and process groups that die on SIGKILL. */
  function fakeOs(lines: string[], { survivors = new Set<number>() } = {}) {
    const alive = new Set<number>()
    for (const line of lines) {
      const pgid = Number(line.trim().split(/\s+/)[1])
      alive.add(pgid)
    }
    const signals: [number, NodeJS.Signals][] = []
    const runFn = vi.fn<typeof run>(async () => psOut([`${ME} ${ME} node src/index.ts`, ...lines]))
    const kill = (pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal])
      if (!alive.has(-pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      if (!survivors.has(-pid)) alive.delete(-pid)
    }
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
    }
    return { runFn, kill, signals, sleep, sleeps }
  }

  const jobs = () => path.join(root, 'jobs')

  it('kills the groups of leftover jobs (one ps, our own group spared) and sweeps their dirs', async () => {
    await mkdir(path.join(jobs(), testUuid(1)), { recursive: true })
    await writeFile(path.join(jobs(), testUuid(1), 'x.webm'), 'audio')
    const marker = `${root}/jobs/${testUuid(1)}`
    const os = fakeOs([
      `500 500 python yt-dlp -P ${marker}`,
      `501 500 ffmpeg -i file:${marker}/x.webm`,
      `${ME + 1} ${ME} ffmpeg -i file:${marker}/x.webm`,
      `600 600 /usr/bin/other`,
    ])
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(result).toEqual({ killed: 1, removed: 1, parts: 0 })
    expect(os.runFn).toHaveBeenCalledExactlyOnceWith(
      '/bin/ps',
      ['-A', '-ww', '-o', 'pid=,pgid=,command='],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_CTYPE: 'en_US.UTF-8' },
        timeoutMs: 10_000,
      },
    )
    expect(os.signals).toEqual([
      [-500, 'SIGKILL'],
      [-500, 'SIGKILL'],
    ])
    expect(os.sleeps).toEqual([])
    expect(await readdir(jobs())).toEqual([])
  })

  it('waits up to 2 s for the killed groups to be gone', async () => {
    const os = fakeOs([`500 500 yt-dlp -P ${root}/jobs/${testUuid(1)}`], {
      survivors: new Set([500]),
    })
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(result.killed).toBe(1)
    expect(os.sleeps).toEqual(Array(40).fill(50))
  })

  it('signals again while it waits, so a member the first signal missed goes too', async () => {
    const os = fakeOs([`500 500 yt-dlp -P ${root}/jobs/${testUuid(1)}`])
    // The group outlives two SIGKILLs (members forked while they went out).
    const sent: string[] = []
    const kill = (pid: number, signal: NodeJS.Signals) => {
      sent.push(`${pid} ${signal}`)
      if (sent.length > 3) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(result.killed).toBe(1)
    expect(sent).toEqual(Array(4).fill('-500 SIGKILL'))
    expect(os.sleeps).toEqual([50, 50])
  })

  it('counts a group with only a zombie left (EPERM) as gone', async () => {
    const signals: unknown[] = []
    const os = fakeOs([`500 500 yt-dlp -P ${root}/jobs/${testUuid(1)}`])
    await sweepLeftovers(root, {
      run: os.runFn,
      kill: (_pid, signal) => {
        signals.push(signal)
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(signals).toEqual(['SIGKILL', 'SIGKILL'])
    expect(os.sleeps).toEqual([])
  })

  it('unlinks a recorded part file only when it is exactly ours, and removes the records', async () => {
    const usb = path.join(root, 'usb')
    await mkdir(jobs(), { recursive: true })
    await mkdir(usb)
    const part = (n: number) => path.join(usb, `.djs-${testUuid(n)}.part`)
    const records: [number, PartRecord][] = [
      [1, { partPath: part(1) }], // ours: unlinked
      [2, { partPath: part(3) }], // another attempt's name: kept
      [4, { partPath: path.join(usb, 'Artist - Title.mp3') }], // a user's file: kept
      [5, { partPath: part(5) }], // a symlink: kept, not followed
      [6, { partPath: `.djs-${testUuid(6)}.part` }], // relative: kept
      [7, { partPath: part(7), placeholderPath: path.join(usb, 'Reserved.mp3') }],
      [8, { partPath: part(8), placeholderPath: path.join(usb, 'Published.mp3') }],
      [9, { partPath: part(9), placeholderPath: path.join(root, 'elsewhere.mp3') }],
      [10, { partPath: part(99) }], // its file is gone already
    ]
    for (const n of [1, 3, 7, 8, 9]) await writeFile(part(n), 'partial audio')
    await writeFile(path.join(usb, 'Artist - Title.mp3'), 'the user’s')
    await writeFile(path.join(root, 'target'), 'not ours')
    await symlink(path.join(root, 'target'), part(5))
    await writeFile(path.join(usb, 'Reserved.mp3'), '')
    await writeFile(path.join(usb, 'Published.mp3'), 'renamed over the placeholder')
    await writeFile(path.join(root, 'elsewhere.mp3'), '')
    for (const [n, body] of records) {
      await writeFile(path.join(jobs(), `${testUuid(n)}.part.json`), JSON.stringify(body))
    }
    await writeFile(path.join(jobs(), `${testUuid(11)}.part.json`), 'not json')
    await writeFile(path.join(jobs(), `${testUuid(12)}.part.json`), JSON.stringify({ partPath: 5 }))
    await symlink(
      path.join(usb, 'Artist - Title.mp3'),
      path.join(jobs(), `${testUuid(13)}.part.json`),
    )

    const os = fakeOs([])
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    // 9 records naming part files, 2 unreadable ones and a symlink named like a record.
    expect(result).toEqual({ killed: 0, removed: 12, parts: 4 })
    expect((await readdir(usb)).sort()).toEqual(
      [
        `.djs-${testUuid(3)}.part`,
        `.djs-${testUuid(5)}.part`,
        'Artist - Title.mp3',
        'Published.mp3',
      ].sort(),
    )
    expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('not ours')
    expect(await readFile(path.join(root, 'elsewhere.mp3'), 'utf8')).toBe('')
    expect(await readdir(jobs())).toEqual([])
  })

  it('cleans up after a publish that died mid-way, from the record publish itself wrote', async () => {
    // One record type on both sides (jobs/types.ts PartRecord): a publish onto an exFAT-like volume
    // (no hard links) whose rename and cleanup fail leaves its part, its empty placeholder and the
    // record naming both, as a crash would. The sweep at the next start removes all three.
    // root is a real path, so the folder's given and real paths agree.
    const usb = path.join(root, 'usb')
    await mkdir(usb)
    await mkdir(jobs(), { recursive: true })
    const src = path.join(root, 'final.mp3')
    await writeFile(src, 'tagged audio')
    const fail = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }))
    const publish = createPublish({
      link: fail('ENOTSUP'),
      rename: fail('EIO'),
      unlink: fail('EBUSY'),
    })
    const folder: TargetFolder = { given: usb, real: usb }
    const attemptId = testUuid(21)
    await expect(
      publish({
        src,
        folder,
        name: 'Artist - Title.mp3',
        attemptId,
        jobsDir: jobs(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'folder_unavailable' })
    const record = path.join(jobs(), `${attemptId}.part.json`)
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      partPath: path.join(usb, `.djs-${attemptId}.part`),
      placeholderPath: path.join(usb, 'Artist - Title.mp3'),
    } satisfies PartRecord)
    expect((await readdir(usb)).sort()).toEqual([`.djs-${attemptId}.part`, 'Artist - Title.mp3'])

    const os = fakeOs([])
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(result).toEqual({ killed: 0, removed: 1, parts: 1 })
    expect(await readdir(usb)).toEqual([])
    expect(await readdir(jobs())).toEqual([])
  })

  describe('a part record whose folder is missing (a drive not plugged in)', () => {
    const DAY = 24 * 60 * 60 * 1000
    const usb = () => path.join(root, 'Volumes', 'USB')
    const part = () => path.join(usb(), `.djs-${testUuid(1)}.part`)
    const placeholder = () => path.join(usb(), 'Artist - Title.mp3')

    async function writeRecord() {
      await mkdir(jobs(), { recursive: true })
      const record: PartRecord = { partPath: part(), placeholderPath: placeholder() }
      await writeFile(path.join(jobs(), `${testUuid(1)}.part.json`), JSON.stringify(record))
    }

    const sweep = (options: { now?: () => number; fs?: SweepDeps['fs'] } = {}) => {
      const os = fakeOs([])
      return sweepLeftovers(root, {
        run: os.runFn,
        kill: os.kill,
        sleep: os.sleep,
        pid: ME,
        log: log(),
        ...options,
      })
    }

    it('is kept, and cleans up the part once the drive is back at a later start', async () => {
      await writeRecord()
      expect(await sweep()).toEqual({ killed: 0, removed: 0, parts: 0 })
      expect(await readdir(jobs())).toEqual([`${testUuid(1)}.part.json`])
      await mkdir(usb(), { recursive: true })
      await writeFile(part(), 'partial audio')
      await writeFile(placeholder(), '')
      expect(await sweep()).toEqual({ killed: 0, removed: 1, parts: 1 })
      expect(await readdir(usb())).toEqual([])
      expect(await readdir(jobs())).toEqual([])
    })

    it('is kept while the folder cannot be read either', async () => {
      await writeRecord()
      await mkdir(usb(), { recursive: true })
      const eio = Object.assign(new Error('EIO'), { code: 'EIO' })
      const result = await sweep({
        fs: { lstat: (file) => (file === usb() ? Promise.reject(eio) : lstat(file)) },
      })
      expect(result).toEqual({ killed: 0, removed: 0, parts: 0 })
      expect(await readdir(jobs())).toEqual([`${testUuid(1)}.part.json`])
    })

    it('is kept for 30 days, then removed', async () => {
      await writeRecord()
      expect(await sweep({ now: () => Date.now() + 29 * DAY })).toMatchObject({ removed: 0 })
      expect(await sweep({ now: () => Date.now() + 31 * DAY })).toMatchObject({ removed: 1 })
      expect(await readdir(jobs())).toEqual([])
    })
  })

  it('removes only job entries, never following a symlink', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep.txt'), 'keep')
    await mkdir(path.join(jobs(), testUuid(1), 'nested'), { recursive: true })
    await writeFile(path.join(jobs(), testUuid(1), 'nested', 'f'), 'x')
    await symlink(outside, path.join(jobs(), testUuid(1), 'link'))
    await symlink(outside, path.join(jobs(), testUuid(2)))
    await writeFile(path.join(jobs(), testUuid(3)), 'a file named like a job')
    const others = [
      'notes.txt',
      `${testUuid(4)}.txt`,
      testUuid(0xabcdef).toUpperCase(),
      `${testUuid(6)}.run.json`,
    ]
    for (const name of others) await writeFile(path.join(jobs(), name), 'x')
    const os = fakeOs([])
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: log(),
    })
    expect(result).toEqual({ killed: 0, removed: 3, parts: 0 })
    expect((await readdir(jobs())).sort()).toEqual([...others].sort())
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect((await lstat(outside)).isDirectory()).toBe(true)
  })

  it('does nothing to the filesystem without a jobs folder', async () => {
    const os = fakeOs([])
    expect(
      await sweepLeftovers(root, {
        run: os.runFn,
        kill: os.kill,
        sleep: os.sleep,
        pid: ME,
        log: log(),
      }),
    ).toEqual({
      killed: 0,
      removed: 0,
      parts: 0,
    })
  })

  it.each([
    [
      'ps cannot start',
      async () => Promise.reject(Object.assign(new Error('spawn'), { code: 'ENOENT' })),
    ],
    ['ps fails', async () => ({ ...psOut([]), exitCode: 1 })],
  ])('still sweeps the jobs folder when %s, killing nothing', async (_name, runImpl) => {
    await mkdir(path.join(jobs(), testUuid(1)), { recursive: true })
    const logger = log()
    const kill = vi.fn()
    const result = await sweepLeftovers(root, {
      run: vi.fn<typeof run>(runImpl),
      kill,
      pid: ME,
      log: logger,
    })
    expect(result).toEqual({ killed: 0, removed: 1, parts: 0 })
    expect(kill).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('kills nothing when this server is not in the process list', async () => {
    const os = fakeOs([`500 500 yt-dlp -P ${root}/jobs/${testUuid(1)}`])
    const logger = log()
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME + 5,
      log: logger,
    })
    expect(result.killed).toBe(0)
    expect(os.signals).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('logs a jobs entry it cannot remove by its code, and goes on', async () => {
    await mkdir(path.join(jobs(), testUuid(1)), { recursive: true })
    await mkdir(path.join(jobs(), testUuid(2)), { recursive: true })
    const logger = log()
    const os = fakeOs([])
    const result = await sweepLeftovers(root, {
      run: os.runFn,
      kill: os.kill,
      sleep: os.sleep,
      pid: ME,
      log: logger,
      fs: {
        rmTree: async (dir) => {
          if (dir.endsWith(testUuid(1)))
            throw Object.assign(new Error(`EBUSY ${dir}`), { code: 'EBUSY' })
          await rm(dir, { recursive: true })
        },
      },
    })
    expect(result.removed).toBe(1)
    expect(logger.warn.mock.calls).toEqual([["[server] Can't remove a leftover job entry (EBUSY)"]])
  })
})
