import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ConfigError,
  DEFAULT_WEB_DIST,
  defaultDataDir,
  defaultDownloadFolder,
  loadConfig,
} from './config.ts'

/** The repo root, from this file (apps/server/src). */
const REPO = path.resolve(import.meta.dirname, '../../..')

/** A home folder injected in place of os.homedir(). */
const HOME = '/Users/dj'
const homedir = () => HOME

/** The ConfigError loadConfig throws, or a failure if it doesn't throw one. */
function configError(
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = [],
  deps: Parameters<typeof loadConfig>[2] = { homedir },
): ConfigError {
  try {
    loadConfig(env, argv, deps)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected loadConfig to throw a ConfigError')
}

describe('loadConfig', () => {
  it('defaults to port 4747, production mode, the web build in the repo and no overrides', () => {
    expect(loadConfig({}, [], { homedir })).toStrictEqual({
      port: 4747,
      dev: false,
      open: false,
      webDist: path.join(REPO, 'apps', 'web', 'dist'),
      dataDir: '/Users/dj/Library/Application Support/DJ Scraper',
      homeDir: '/Users/dj',
      engine: {},
    })
  })

  it('takes the home folder from os.homedir() unless one is injected', () => {
    expect(loadConfig({}, []).homeDir).toBe(os.homedir())
    expect(loadConfig({}, []).dataDir).toBe(defaultDataDir(os.homedir()))
  })

  it('finds the web build from the source location, not the cwd', async () => {
    expect(DEFAULT_WEB_DIST).toBe(path.join(REPO, 'apps', 'web', 'dist'))
    // Evaluated again from another cwd, so a cwd-relative default would show.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/')
    try {
      vi.resetModules()
      const { DEFAULT_WEB_DIST: fromRoot } = await import('./config.ts')
      expect(fromRoot).toBe(path.join(REPO, 'apps', 'web', 'dist'))
    } finally {
      cwd.mockRestore()
    }
  })

  it.each([
    ['1024', 1024],
    ['4747', 4747],
    ['5000', 5000],
    ['65535', 65535],
  ])('accepts PORT %s', (PORT, port) => {
    expect(loadConfig({ PORT }, []).port).toBe(port)
  })

  it('treats an empty PORT as unset', () => {
    expect(loadConfig({ PORT: '' }, []).port).toBe(4747)
  })

  it.each([
    ['80, a default port browsers drop from Host', '80'],
    ['1023, a privileged port', '1023'],
    ['0, a random port the UI could not find', '0'],
    ['70000, above the port range', '70000'],
    ['65536, just above the port range', '65536'],
    ['not a number', 'abc'],
    ['negative', '-1'],
    ['fractional', '4747.5'],
    ['padded with spaces', ' 4747'],
    ['in hex', '0x128B'],
    ['six digits', '004747'],
  ])('rejects a PORT that is %s', (_label, PORT) => {
    const error = configError({ PORT })
    expect(error.message).toMatch(/^Invalid environment:/)
    expect(error.message).toContain('PORT')
  })

  it('turns on dev mode with --dev', () => {
    expect(loadConfig({}, ['--dev'])).toMatchObject({ dev: true, open: false })
  })

  it('asks for the browser with --open', () => {
    expect(loadConfig({}, ['--open'])).toMatchObject({ dev: false, open: true })
  })

  it('parses --open next to --dev (startup ignores it in dev mode)', () => {
    expect(loadConfig({}, ['--dev', '--open'])).toMatchObject({ dev: true, open: true })
  })

  it.each([
    ['an unknown flag', ['--verbose'], '--verbose'],
    ['a positional argument', ['serve'], 'serve'],
    ['a value for --dev', ['--dev=false'], '--dev'],
    ['a value for --open', ['--open=false'], '--open'],
  ])('rejects %s with a ConfigError', (_label, argv, mentioned) => {
    const error = configError({}, argv)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ConfigError')
    expect(error.message).toContain(mentioned)
  })

  it('passes absolute YTDLP_PATH and FFMPEG_PATH overrides and PATH to the engine', () => {
    const env = {
      YTDLP_PATH: '/Users/dj/bin/yt-dlp_macos',
      FFMPEG_PATH: '/opt/ffmpeg',
      PATH: '/opt/homebrew/bin:/usr/bin',
    }
    expect(loadConfig(env, []).engine).toStrictEqual(env)
  })

  it('keeps unrelated environment variables out of the engine config', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/dj',
      YTDLP_COOKIES: 'secret',
      PORT: '5000',
      DJS_WEB_DIST: '/tmp/dist',
      DJS_DATA_DIR: '/tmp/data',
    }
    expect(loadConfig(env, []).engine).toStrictEqual({ PATH: '/usr/bin' })
  })

  it.each(['YTDLP_PATH', 'FFMPEG_PATH'])('treats an empty %s as unset', (name) => {
    expect(loadConfig({ [name]: '' }, []).engine).toEqual({})
  })

  it('serves the web build from an absolute DJS_WEB_DIST', () => {
    expect(loadConfig({ DJS_WEB_DIST: '/tmp/e2e/dist' }, []).webDist).toBe('/tmp/e2e/dist')
  })

  it('treats an empty DJS_WEB_DIST as unset', () => {
    expect(loadConfig({ DJS_WEB_DIST: '' }, []).webDist).toBe(DEFAULT_WEB_DIST)
  })

  it('keeps the app data dir in an absolute DJS_DATA_DIR', () => {
    const config = loadConfig({ DJS_DATA_DIR: '/tmp/djs-test/data' }, [], { homedir })
    expect(config).toMatchObject({ dataDir: '/tmp/djs-test/data', homeDir: HOME })
  })

  it('treats an empty DJS_DATA_DIR as unset', () => {
    expect(loadConfig({ DJS_DATA_DIR: '' }, [], { homedir }).dataDir).toBe(defaultDataDir(HOME))
  })

  it('moves the data dir and the default folder with the home folder', () => {
    const config = loadConfig({}, [], { homedir: () => '/private/tmp/home' })
    expect(config.homeDir).toBe('/private/tmp/home')
    expect(config.dataDir).toBe('/private/tmp/home/Library/Application Support/DJ Scraper')
    expect(defaultDownloadFolder(config.homeDir)).toBe('/private/tmp/home/Music/DJ Scraper')
  })

  // What keeps a spawned server off the user's real folders: test/helpers.ts serverEnv sets HOME.
  it('follows HOME through os.homedir()', () => {
    vi.stubEnv('HOME', '/private/tmp/dj-scraper-home')
    try {
      expect(loadConfig({}, [])).toMatchObject({
        homeDir: '/private/tmp/dj-scraper-home',
        dataDir: '/private/tmp/dj-scraper-home/Library/Application Support/DJ Scraper',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('creates no directories', () => {
    const home = path.join(os.tmpdir(), `dj-scraper-config-${process.pid}-${Date.now()}`)
    const config = loadConfig({}, [], { homedir: () => home })
    expect(existsSync(home)).toBe(false)
    expect(existsSync(config.dataDir)).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['relative', 'Users/dj'],
    ['~', '~'],
  ])('rejects a home folder that is %s', (_label, home) => {
    const error = configError({}, [], { homedir: () => home })
    expect(error.message).toBe(
      `The home folder must be an absolute path, not ${JSON.stringify(home)} (check HOME)`,
    )
  })

  it.each([
    ['YTDLP_PATH', 'bin/yt-dlp'],
    ['YTDLP_PATH', './yt-dlp'],
    ['YTDLP_PATH', '~/bin/yt-dlp'],
    ['FFMPEG_PATH', '~/ffmpeg'],
    ['FFMPEG_PATH', 'ffmpeg'],
    ['DJS_WEB_DIST', 'apps/web/dist'],
    ['DJS_WEB_DIST', '~/dist'],
    ['DJS_DATA_DIR', 'data'],
    ['DJS_DATA_DIR', '~/Library/Application Support/DJ Scraper'],
  ])('rejects a relative %s %j (it would depend on the cwd)', (name, value) => {
    const error = configError({ [name]: value })
    expect(error.message).toContain(name)
    expect(error.message).toContain('must be an absolute path')
  })

  it('reports every invalid variable at once', () => {
    const error = configError({
      PORT: 'abc',
      YTDLP_PATH: 'yt-dlp',
      FFMPEG_PATH: 'ffmpeg',
      DJS_WEB_DIST: 'dist',
      DJS_DATA_DIR: 'data',
    })
    for (const name of ['PORT', 'YTDLP_PATH', 'FFMPEG_PATH', 'DJS_WEB_DIST', 'DJS_DATA_DIR']) {
      expect(error.message).toContain(name)
    }
  })
})

describe('defaultDataDir', () => {
  it('is Library/Application Support/DJ Scraper in the home folder', () => {
    expect(defaultDataDir('/Users/dj')).toBe('/Users/dj/Library/Application Support/DJ Scraper')
  })
})

describe('defaultDownloadFolder', () => {
  it('is Music/DJ Scraper in the home folder', () => {
    expect(defaultDownloadFolder('/Users/dj')).toBe('/Users/dj/Music/DJ Scraper')
  })
})
