import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

/** The ConfigError loadConfig throws, or a failure if it doesn't throw one. */
function configError(env: NodeJS.ProcessEnv, argv: readonly string[] = []): ConfigError {
  try {
    loadConfig(env, argv)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected loadConfig to throw a ConfigError')
}

describe('loadConfig', () => {
  it('defaults to port 4747, production mode and no engine overrides', () => {
    expect(loadConfig({}, [])).toStrictEqual({ port: 4747, dev: false, engine: {} })
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
    expect(loadConfig({}, ['--dev']).dev).toBe(true)
  })

  it.each([
    ['an unknown flag', ['--verbose'], '--verbose'],
    ['a positional argument', ['serve'], 'serve'],
    ['a value for --dev', ['--dev=false'], '--dev'],
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
    const env = { PATH: '/usr/bin', HOME: '/Users/dj', YTDLP_COOKIES: 'secret', PORT: '5000' }
    expect(loadConfig(env, []).engine).toStrictEqual({ PATH: '/usr/bin' })
  })

  it.each(['YTDLP_PATH', 'FFMPEG_PATH'])('treats an empty %s as unset', (name) => {
    expect(loadConfig({ [name]: '' }, []).engine).toEqual({})
  })

  it.each([
    ['YTDLP_PATH', 'bin/yt-dlp'],
    ['YTDLP_PATH', './yt-dlp'],
    ['YTDLP_PATH', '~/bin/yt-dlp'],
    ['FFMPEG_PATH', '~/ffmpeg'],
    ['FFMPEG_PATH', 'ffmpeg'],
  ])('rejects a relative %s %j (it would depend on the cwd)', (name, value) => {
    const error = configError({ [name]: value })
    expect(error.message).toContain(name)
    expect(error.message).toContain('must be an absolute path')
  })

  it('reports every invalid variable at once', () => {
    const error = configError({ PORT: 'abc', YTDLP_PATH: 'yt-dlp', FFMPEG_PATH: 'ffmpeg' })
    for (const name of ['PORT', 'YTDLP_PATH', 'FFMPEG_PATH']) expect(error.message).toContain(name)
  })
})
