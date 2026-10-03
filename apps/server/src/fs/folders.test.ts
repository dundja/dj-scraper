import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { StepError } from '../jobs/types.ts'
import {
  checkPickedFolder,
  type FolderOps,
  folderError,
  insideFolder,
  PRIVACY_MESSAGE,
  recheckFolder,
  resolveTargetFolder,
} from './folders.ts'

let root: string
let rootReal: string
let dataDir: string

beforeAll(async () => {
  // os.tmpdir() is /var/folders/…, whose real path is /private/var/folders/….
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-folders-'))
  rootReal = await realpath(root)
  dataDir = path.join(rootReal, 'data')
  await mkdir(path.join(dataDir, 'jobs'), { recursive: true })
})

afterAll(async () => {
  await chmod(path.join(root, 'locked'), 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

async function folder(name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

const context = () => ({ dataDirReal: dataDir })

/** Rejects with a StepError of this code (and message, when given). */
async function expectStepError(
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<StepError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(StepError)
  const stepError = error as StepError
  expect(stepError.code).toBe(code)
  if (message !== undefined) expect(stepError.message).toBe(message)
  // Never a path in a message for the user.
  expect(stepError.message).not.toContain(root)
  expect(stepError.message).not.toContain(rootReal)
  return stepError
}

const errno = (code: string) => Object.assign(new Error(`${code}: /secret/path`), { code })

describe('resolveTargetFolder', () => {
  it('resolves an existing writable folder to its real path, keeping the given form', async () => {
    const dir = await folder('Music')
    await expect(resolveTargetFolder(dir, undefined, context())).resolves.toEqual({
      given: dir,
      real: path.join(rootReal, 'Music'),
    })
  })

  it('drops one trailing slash, as the macOS picker returns it', async () => {
    const dir = await folder('Picked')
    await expect(resolveTargetFolder(`${dir}/`, undefined, context())).resolves.toEqual({
      given: dir,
      real: path.join(rootReal, 'Picked'),
    })
  })

  it.each([
    ['a relative path', 'Music'],
    ['a home-relative path', '~/Music'],
    ['a .. segment', '/Users/dj/../Music'],
    ['a control character', '/Users/dj/Mu\nsic'],
  ])('refuses %s as invalid_request', async (_label, given) => {
    await expectStepError(
      resolveTargetFolder(given, undefined, context()),
      'invalid_request',
      'Choose a folder by its full path, starting with /.',
    )
  })

  it('refuses a missing folder, and creates it only when asked (the default folder)', async () => {
    const missing = path.join(root, 'home', 'Music', 'DJ Scraper')
    await expectStepError(
      resolveTargetFolder(missing, undefined, context()),
      'folder_unavailable',
      "That folder doesn't exist. Check the path, or that its drive is connected.",
    )
    await expect(
      resolveTargetFolder(missing, undefined, { ...context(), create: true }),
    ).resolves.toEqual({ given: missing, real: path.join(rootReal, 'home', 'Music', 'DJ Scraper') })
    // Already there: create is a no-op.
    await expect(
      resolveTargetFolder(missing, undefined, { ...context(), create: true }),
    ).resolves.toMatchObject({ given: missing })
  })

  it('refuses a file', async () => {
    const file = path.join(root, 'a-file.mp3')
    await writeFile(file, 'x')
    await expectStepError(
      resolveTargetFolder(file, undefined, context()),
      'folder_unavailable',
      "That path isn't a folder.",
    )
    await expectStepError(
      resolveTargetFolder(`${file}/inside`, undefined, context()),
      'folder_unavailable',
      "That path isn't a folder.",
    )
  })

  it('refuses a folder it may not write to', async () => {
    const locked = await folder('locked')
    await chmod(locked, 0o555)
    await expectStepError(
      resolveTargetFolder(locked, undefined, context()),
      'folder_unavailable',
      "DJ Scraper isn't allowed to write to that folder.",
    )
    await chmod(locked, 0o755)
  })

  it('follows a symlinked folder to its real path', async () => {
    const target = await folder('Real Target')
    const link = path.join(root, 'Link To Target')
    await symlink(target, link)
    await expect(resolveTargetFolder(link, undefined, context())).resolves.toEqual({
      given: link,
      real: path.join(rootReal, 'Real Target'),
    })
  })

  describe('the data dir', () => {
    it.each([
      ['the data dir itself', () => dataDir],
      ['a folder inside it', () => path.join(dataDir, 'jobs')],
      ['its non-real form', () => path.join(root, 'data', 'jobs')],
    ])('refuses %s', async (_label, given) => {
      await expectStepError(
        resolveTargetFolder(given(), undefined, context()),
        'folder_unavailable',
        "That folder is inside DJ Scraper's own data folder. Choose another one.",
      )
    })

    it('refuses it in another letter case on a case-insensitive volume', async ({ skip }) => {
      const upper = path.join(rootReal, 'DATA', 'JOBS')
      if ((await realpath(upper).catch(() => undefined)) === undefined) skip()
      await expectStepError(resolveTargetFolder(upper, undefined, context()), 'folder_unavailable')
    })

    it('refuses it as a subfolder of a parent folder', async () => {
      await expectStepError(resolveTargetFolder(rootReal, 'data', context()), 'folder_unavailable')
    })

    it('allows a sibling whose name starts like it, and the folder holding it', async () => {
      const sibling = await folder('data-other')
      await expect(resolveTargetFolder(sibling, undefined, context())).resolves.toMatchObject({
        real: path.join(rootReal, 'data-other'),
      })
      await expect(resolveTargetFolder(rootReal, undefined, context())).resolves.toMatchObject({
        real: rootReal,
      })
    })
  })

  describe('subfolder', () => {
    it('creates one sanitized folder inside', async () => {
      const dir = await folder('Sub')
      const target = await resolveTargetFolder(dir, 'Summer Set: House/Techno', context())
      expect(target).toEqual({
        given: path.join(dir, 'Summer Set - House-Techno'),
        real: path.join(rootReal, 'Sub', 'Summer Set - House-Techno'),
      })
      expect(await realpath(target.given)).toBe(target.real)
    })

    it('reuses an existing one, in its on-disk case', async ({ skip }) => {
      const dir = await folder('Reuse')
      await mkdir(path.join(dir, 'My Mix'))
      await expect(resolveTargetFolder(dir, 'My Mix', context())).resolves.toEqual({
        given: path.join(dir, 'My Mix'),
        real: path.join(rootReal, 'Reuse', 'My Mix'),
      })
      const caseInsensitive = await realpath(path.join(dir, 'MY MIX')).then(
        () => true,
        () => false,
      )
      if (!caseInsensitive) skip()
      const target = await resolveTargetFolder(dir, 'my mix', context())
      expect(target).toEqual({
        given: path.join(dir, 'my mix'),
        real: path.join(rootReal, 'Reuse', 'My Mix'),
      })
      await expect(recheckFolder(target)).resolves.toBeUndefined()
    })

    it.each(['..', '.', '...', '???', '  '])('refuses the unusable name %j', async (name) => {
      const dir = await folder('Unusable')
      await expectStepError(
        resolveTargetFolder(dir, name, context()),
        'invalid_request',
        "The subfolder name can't be used as a folder name.",
      )
    })

    it('refuses a subfolder that is a symlink to another place', async () => {
      const dir = await folder('Linked')
      const elsewhere = await folder('Elsewhere')
      await symlink(elsewhere, path.join(dir, 'Set'))
      await expectStepError(
        resolveTargetFolder(dir, 'Set', context()),
        'folder_unavailable',
        'The subfolder is a link to another place. Rename or remove it, or turn off playlist subfolders.',
      )
    })

    it('refuses a subfolder that is a symlink to a folder beside it', async () => {
      const dir = await folder('LinkedSibling')
      await mkdir(path.join(dir, 'Other'))
      await symlink('Other', path.join(dir, 'My Playlist'))
      await expectStepError(
        resolveTargetFolder(dir, 'My Playlist', context()),
        'folder_unavailable',
        'The subfolder is a link to another place. Rename or remove it, or turn off playlist subfolders.',
      )
    })

    it('refuses a subfolder whose given path gets longer than the API allows, though its real path is short', async () => {
      // A long path that leads to a short one through a symlink (an alias of a drive, say).
      const given = `/${Array.from({ length: 9 }, () => 'a'.repeat(100)).join('/')}`
      const made: string[] = []
      const ops: Partial<FolderOps> = {
        realpath: async (file) => (file === given ? '/Volumes/USB' : file),
        stat: async () => ({ isDirectory: () => true }),
        access: async () => {},
        mkdir: async (dir) => {
          made.push(dir)
        },
        lstat: async () => ({ isSymbolicLink: () => false }),
      }
      await expectStepError(
        resolveTargetFolder(given, 's'.repeat(150), context(), ops),
        'invalid_request',
        'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
      )
      expect(made).toEqual([])
      // Under 1024 UTF-16 units but over 1024 bytes: macOS counts bytes when publish resolves it.
      const wide = `/${Array.from({ length: 4 }, () => '日'.repeat(100)).join('/')}`
      await expectStepError(
        resolveTargetFolder(wide, 's'.repeat(50), context(), {
          ...ops,
          realpath: async (file) => (file === wide ? '/Volumes/USB' : file),
        }),
        'invalid_request',
        'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
      )
      expect(made).toEqual([])
      // Under a shorter given path, the same subfolder fits.
      await expect(
        resolveTargetFolder('/Volumes/USB', 's'.repeat(150), context(), ops),
      ).resolves.toEqual({
        given: `/Volumes/USB/${'s'.repeat(150)}`,
        real: `/Volumes/USB/${'s'.repeat(150)}`,
      })
    })

    it('refuses a file in the way', async () => {
      const dir = await folder('FileInWay')
      await writeFile(path.join(dir, 'Set'), 'x')
      await expectStepError(
        resolveTargetFolder(dir, 'Set', context()),
        'folder_unavailable',
        "That path isn't a folder.",
      )
    })
  })

  it('refuses a folder whose path leaves no room for a 180-character file name', async () => {
    // Nest ASCII folders until the real path plus a 180-byte name reaches 1024 bytes.
    let deep = rootReal
    while (Buffer.byteLength(path.join(deep, 'x'.repeat(180))) < 1024) {
      deep = path.join(deep, 'd'.repeat(Math.min(200, 1024 - Buffer.byteLength(deep))))
    }
    const shallower = path.dirname(deep)
    await mkdir(deep, { recursive: true }).catch(() => mkdir(shallower, { recursive: true }))
    const created = await realpath(deep).then(
      () => deep,
      () => shallower,
    )
    if (created === deep) {
      await expectStepError(
        resolveTargetFolder(deep, undefined, context()),
        'invalid_request',
        'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
      )
    }
    // A subfolder counts too, before it is created.
    await expectStepError(
      resolveTargetFolder(shallower, 'x'.repeat(170), context()),
      'invalid_request',
    )
  })

  it.each([
    ['EPERM', 'folder_unavailable', PRIVACY_MESSAGE],
    ['EACCES', 'folder_unavailable', "DJ Scraper isn't allowed to write to that folder."],
    ['EROFS', 'folder_unavailable', 'That folder is on a read-only drive.'],
    ['ENAMETOOLONG', 'invalid_request', 'That folder path is too long.'],
    ['ELOOP', 'folder_unavailable', 'That folder path has a link that loops.'],
    ['EIO', 'folder_unavailable', "That folder can't be used (EIO)."],
  ])('maps %s from realpath to %s', async (code, expected, message) => {
    const ops: Partial<FolderOps> = { realpath: () => Promise.reject(errno(code)) }
    await expectStepError(
      resolveTargetFolder('/Volumes/USB', undefined, context(), ops),
      expected,
      message,
    )
  })

  it('maps EPERM from the write check (macOS privacy) and EROFS (a locked card)', async () => {
    const dir = await folder('Privacy')
    await expectStepError(
      resolveTargetFolder(dir, undefined, context(), {
        access: () => Promise.reject(errno('EPERM')),
      }),
      'folder_unavailable',
      PRIVACY_MESSAGE,
    )
    await expectStepError(
      resolveTargetFolder(dir, undefined, context(), {
        access: () => Promise.reject(errno('EROFS')),
      }),
      'folder_unavailable',
      'That folder is on a read-only drive.',
    )
  })

  it('maps errors creating the default folder or a subfolder', async () => {
    await expectStepError(
      resolveTargetFolder(
        '/Users/dj/Music/DJ Scraper',
        undefined,
        { ...context(), create: true },
        {
          mkdir: () => Promise.reject(errno('EACCES')),
        },
      ),
      'folder_unavailable',
    )
    const dir = await folder('SubErrors')
    await expectStepError(
      resolveTargetFolder(dir, 'Set', context(), { mkdir: () => Promise.reject(errno('ENOSPC')) }),
      'folder_unavailable',
      'The drive of that folder is full.',
    )
  })
})

describe('checkPickedFolder', () => {
  /** An open folder whose read answers as told. */
  const fakeDir = (read: () => Promise<unknown> = async () => null) => ({
    read: vi.fn(read),
    close: vi.fn(async () => {}),
  })

  it('accepts a writable folder outside the data dir once it has read its first entry', async () => {
    const dir = await folder('Picked Set')
    await writeFile(path.join(dir, 'track.mp3'), 'x')
    const handle = fakeDir()
    const opendir = vi.fn(async (_dir: string) => handle)
    await expect(checkPickedFolder(dir, context(), { opendir })).resolves.toBeUndefined()
    expect(opendir).toHaveBeenCalledExactlyOnceWith(path.join(rootReal, 'Picked Set'))
    expect(handle.read).toHaveBeenCalledOnce()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['an empty folder', () => folder('Picked Empty')],
    [
      'a folder full of files',
      async () => {
        const dir = await folder('Picked Full')
        await Promise.all(
          Array.from({ length: 100 }, (_, i) => writeFile(path.join(dir, `${i}.mp3`), '')),
        )
        return dir
      },
    ],
    [
      'a symlink to a folder',
      async () => {
        const link = path.join(root, 'Picked Link')
        await symlink(await folder('Picked Target'), link)
        return link
      },
    ],
    ['a path with a trailing slash', async () => `${await folder('Picked Slash')}/`],
  ])('accepts %s on the real filesystem', async (_label, picked) => {
    await expect(checkPickedFolder(await picked(), context())).resolves.toBeUndefined()
  })

  it('accepts a folder it may write to but not list (a drop box): downloads only write', async () => {
    const dir = await folder('Drop Box')
    await chmod(dir, 0o333)
    try {
      await expect(checkPickedFolder(dir, context())).resolves.toBeUndefined()
    } finally {
      await chmod(dir, 0o755)
    }
    await expect(
      checkPickedFolder(dir, context(), { opendir: () => Promise.reject(errno('EACCES')) }),
    ).resolves.toBeUndefined()
  })

  it('refuses a folder macOS privacy settings block, naming them, and closes it', async () => {
    // Desktop, Documents, a USB drive: once the user said no, reading inside fails EPERM.
    const dir = await folder('Picked Private')
    const handle = fakeDir(() => Promise.reject(errno('EPERM')))
    await expectStepError(
      checkPickedFolder(dir, context(), { opendir: async () => handle }),
      'folder_unavailable',
      PRIVACY_MESSAGE,
    )
    expect(handle.close).toHaveBeenCalledOnce()
    await expectStepError(
      checkPickedFolder(dir, context(), { opendir: () => Promise.reject(errno('EPERM')) }),
      'folder_unavailable',
      PRIVACY_MESSAGE,
    )
  })

  it.each([
    ['ENOENT', "That folder doesn't exist. Check the path, or that its drive is connected."],
    ['EIO', "That folder can't be used (EIO)."],
  ])('maps %s from opening or reading it', async (code, message) => {
    const dir = await folder('Picked Errors')
    await expectStepError(
      checkPickedFolder(dir, context(), { opendir: () => Promise.reject(errno(code)) }),
      'folder_unavailable',
      message,
    )
    const handle = fakeDir(() => Promise.reject(errno(code)))
    await expectStepError(
      checkPickedFolder(dir, context(), { opendir: async () => handle }),
      'folder_unavailable',
      message,
    )
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('ignores a failure to close the folder after reading it', async () => {
    const dir = await folder('Picked Close')
    const handle = { read: async () => null, close: () => Promise.reject(errno('EBADF')) }
    await expect(
      checkPickedFolder(dir, context(), { opendir: async () => handle }),
    ).resolves.toBeUndefined()
  })

  describe('what enqueue refuses', () => {
    it.each([
      [
        'a missing folder',
        async () => path.join(root, 'picked-gone'),
        "That folder doesn't exist. Check the path, or that its drive is connected.",
      ],
      [
        'a file',
        async () => {
          const file = path.join(root, 'picked.mp3')
          await writeFile(file, 'x')
          return file
        },
        "That path isn't a folder.",
      ],
      [
        'the data dir',
        async () => path.join(dataDir, 'jobs'),
        "That folder is inside DJ Scraper's own data folder. Choose another one.",
      ],
    ])('refuses %s without reading it', async (_label, picked, message) => {
      const opendir = vi.fn(async () => fakeDir())
      await expectStepError(
        checkPickedFolder(await picked(), context(), { opendir }),
        'folder_unavailable',
        message,
      )
      expect(opendir).not.toHaveBeenCalled()
    })

    it('refuses a folder it may not write to', async () => {
      const dir = await folder('picked-read-only')
      await chmod(dir, 0o555)
      try {
        await expectStepError(
          checkPickedFolder(dir, context()),
          'folder_unavailable',
          "DJ Scraper isn't allowed to write to that folder.",
        )
      } finally {
        await chmod(dir, 0o755)
      }
    })

    it('never creates a missing folder', async () => {
      const missing = path.join(root, 'picked-never-made', 'DJ Scraper')
      await expectStepError(checkPickedFolder(missing, context()), 'folder_unavailable')
      await expect(realpath(path.join(root, 'picked-never-made'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })

    it.each([
      [
        'a relative path (the picker never answers one)',
        'Music',
        {},
        'Choose a folder by its full path, starting with /.',
      ],
      [
        'a path macOS finds too long',
        '/Volumes/USB',
        { realpath: () => Promise.reject(errno('ENAMETOOLONG')) },
        'That folder path is too long.',
      ],
      [
        'a path that leaves no room for the file names',
        '/Volumes/USB',
        {
          realpath: async (file: string) =>
            file === '/Volumes/USB' ? `/${'a'.repeat(900)}` : file,
          stat: async () => ({ isDirectory: () => true }),
          access: async () => {},
        },
        'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
      ],
    ] satisfies [string, string, Partial<FolderOps>, string][])(
      'refuses %s as folder_unavailable, where enqueue says invalid_request',
      async (_label, picked, ops, message) => {
        await expectStepError(
          checkPickedFolder(picked, context(), ops),
          'folder_unavailable',
          message,
        )
      },
    )
  })
})

describe('recheckFolder', () => {
  it('passes while the folder still resolves to the same real path', async () => {
    const dir = await folder('Stable')
    const target = await resolveTargetFolder(dir, undefined, context())
    await expect(recheckFolder(target)).resolves.toBeUndefined()
  })

  it.each([
    [
      'renamed',
      async (dir: string) => {
        await rename(dir, `${dir}-renamed`)
      },
    ],
    [
      'removed',
      async (dir: string) => {
        await rm(dir, { recursive: true })
      },
    ],
    [
      'replaced by a symlink to another folder',
      async (dir: string) => {
        const other = `${dir}-other`
        await mkdir(other)
        await rm(dir, { recursive: true })
        await symlink(other, dir)
      },
    ],
    [
      'replaced by a file',
      async (dir: string) => {
        await rm(dir, { recursive: true })
        await writeFile(dir, 'x')
      },
    ],
  ])('fails when the folder was %s', async (label, change) => {
    const dir = await folder(`Recheck ${label}`)
    const target = await resolveTargetFolder(dir, undefined, context())
    await change(dir)
    await expectStepError(
      recheckFolder(target),
      'folder_unavailable',
      'The download folder was moved, renamed or its drive was disconnected.',
    )
  })

  it('never creates the folder', async () => {
    const target = { given: path.join(root, 'never-made'), real: path.join(rootReal, 'never-made') }
    await expectStepError(recheckFolder(target), 'folder_unavailable')
    await expect(realpath(target.given)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps other errors by code', async () => {
    await expectStepError(
      recheckFolder(
        { given: '/Volumes/USB', real: '/Volumes/USB' },
        {
          realpath: () => Promise.reject(errno('EPERM')),
        },
      ),
      'folder_unavailable',
      PRIVACY_MESSAGE,
    )
  })
})

describe('insideFolder', () => {
  it.each([
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c', true],
    ['/a/b', '/a/b/c/d.mp3', true],
    ['/a/b', '/a/b/..c', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/a/c/b', false],
    ['/a/b', '/', false],
    ['/', '/anything', true],
  ])('%s holds %s: %s', (base, candidate, expected) => {
    expect(insideFolder(base, candidate)).toBe(expected)
  })
})

describe('folderError', () => {
  it('never quotes the error message (it holds the path)', () => {
    const error = folderError(errno('EWHATEVER'))
    expect(error.message).toBe("That folder can't be used (EWHATEVER).")
    expect(folderError(new Error('/secret/path')).message).toBe(
      "That folder can't be used (error).",
    )
  })
})
