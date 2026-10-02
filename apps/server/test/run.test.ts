import { getEventListeners } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killActiveGroups, run, SpawnError } from '../src/engine/run.ts'

// Fake children are `node -e <script>`: offline, fast, and the same on every machine.
const node = process.execPath
const js = (source: string): string[] => ['-e', source]

/** Child that starts a grandchild (like yt-dlp → ffmpeg) and prints `GC <pid>` once it is ready. */
const withGrandchild = ({
  grandchildIgnoresSigint = false,
  childIgnoresSigint = false,
  childExits = false,
} = {}): string[] => {
  const grandchild = [
    grandchildIgnoresSigint ? "process.on('SIGINT', () => {})" : '',
    "console.log('GC ' + process.pid)",
    'setInterval(() => {}, 1000)',
  ].join(';')
  return js(`
    ${childIgnoresSigint ? "process.on('SIGINT', () => {})" : ''}
    const gc = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' })
    ${childExits ? 'gc.unref()' : 'setInterval(() => {}, 1000)'}
  `)
}

/**
 * Whether `pid` is still running. A killed grandchild is an orphan that launchd/init reaps on its
 * own schedule; until then it is a zombie, which kill(pid, 0) still finds. A zombie is dead
 * (it holds no pipes and runs no code), so ask ps for its state instead of polling.
 */
const isAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const ps = await run('ps', ['-o', 'stat=', '-p', String(pid)])
  // Exit 1 and no output: it was reaped between the two checks.
  return ps.stdout.trim() !== '' && !ps.stdout.trim().startsWith('Z')
}

/** Resolves with the grandchild pid from a `GC <pid>` line, for passing to onStdoutLine. */
const grandchildPid = () => {
  let resolvePid: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve
  })
  const onStdoutLine = (line: string): void => {
    const match = /^GC (\d+)$/.exec(line)
    if (match?.[1]) resolvePid(Number(match[1]))
  }
  return { pid, onStdoutLine }
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'run-test-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
// Detached children outlive a timed-out test (Vitest can't reach their group), so reap them.
afterEach(() => {
  killActiveGroups()
})

describe('run: output', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const result = await run(
      node,
      js("process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exitCode = 3"),
    )
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: 'out\n',
      stderr: 'err\n',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    expect(result.pid).toBeGreaterThan(0)
  })

  it('passes argv verbatim, without a shell', async () => {
    const tricky = ['$(touch pwned)', '; rm -rf /', '"quoted" \'single\'', '--', 'é 🎵']
    const result = await run(node, [
      ...js('process.stdout.write(JSON.stringify(process.argv.slice(1)))'),
      ...tricky,
    ])
    expect(JSON.parse(result.stdout)).toEqual(tricky)
  })

  it('splits lines across chunk and UTF-8 boundaries (\\n, \\r\\n, lone \\r, no final newline)', async () => {
    const lines: string[] = []
    const source = `
      const write = (b) => new Promise((r) => process.stdout.write(b, () => setTimeout(r, 20)))
      ;(async () => {
        await write('one\\r'); await write('\\ntwo\\rthree\\n\\n')
        const b = Buffer.from('caf\\u00e9 \\u{1F3B5}\\n')
        await write(b.subarray(0, 4)); await write(b.subarray(4, 7)); await write(b.subarray(7))
        await write('tail')
      })()`
    const result = await run(node, js(source), { onStdoutLine: (line) => lines.push(line) })
    expect(lines).toEqual(['one', 'two', 'three', '', 'café 🎵', 'tail'])
    expect(result.stdout).toBe('one\r\ntwo\rthree\n\ncafé 🎵\ntail')
  })

  it('gives the child an empty stdin, so a program that reads it does not hang', async () => {
    const result = await run(
      node,
      js("process.stdin.resume(); process.stdin.on('end', () => console.log('EOF'))"),
      { timeoutMs: 5_000 },
    )
    expect(result).toMatchObject({ stdout: 'EOF\n', exitCode: 0, timedOut: false })
  })

  it('runs with exactly the env it is given, without inheriting ours', async () => {
    const result = await run(node, js('process.stdout.write(JSON.stringify(process.env))'), {
      env: { DJ_SCRAPER_TEST: '1' },
    })
    const env: unknown = JSON.parse(result.stdout)
    expect(env).toMatchObject({ DJ_SCRAPER_TEST: '1' })
    expect(env).not.toHaveProperty('PATH')
  })

  it('does not arm an infinite timeoutMs (setTimeout would fire it after 1 ms)', async () => {
    const result = await run(node, js('setTimeout(() => {}, 100)'), {
      timeoutMs: Number.POSITIVE_INFINITY,
    })
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false })
  })

  it('keeps the tail when output exceeds maxOutputBytes, without a broken first character', async () => {
    const result = await run(
      node,
      js("process.stdout.write('é'.repeat(1000) + 'END')"), // 2003 bytes
      { maxOutputBytes: 100 },
    )
    expect(result.truncated).toBe(true)
    expect(result.stdout.endsWith('END')).toBe(true)
    expect(result.stdout).not.toContain('�')
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(100)
  })
})

describe('run: spawn errors', () => {
  it('rejects with SpawnError ENOENT for a missing binary', async () => {
    const error = await run('/nonexistent/yt-dlp', ['--version']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SpawnError)
    expect(error).toMatchObject({ code: 'ENOENT', bin: '/nonexistent/yt-dlp' })
  })

  it('rejects with SpawnError EACCES for a file without the exec bit', async () => {
    const file = join(dir, 'not-executable')
    await writeFile(file, '#!/bin/sh\necho hi\n')
    await chmod(file, 0o644)
    await expect(run(file, [])).rejects.toMatchObject({ name: 'SpawnError', code: 'EACCES' })
  })

  it('rejects with SpawnError ENOEXEC for an executable without a shebang (thrown synchronously by spawn)', async () => {
    const file = join(dir, 'no-shebang')
    await writeFile(file, 'echo hi\n')
    await chmod(file, 0o755)
    await expect(run(file, [])).rejects.toMatchObject({ name: 'SpawnError', code: 'ENOEXEC' })
  })

  it('reports a missing cwd as ENOENT on the binary (Node quirk)', async () => {
    await expect(run(node, js(''), { cwd: join(dir, 'missing') })).rejects.toMatchObject({
      code: 'ENOENT',
      bin: node,
    })
  })

  it('rejects a NUL byte in argv instead of spawning', async () => {
    await expect(run(node, ['-e', 'a\u0000b'])).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    })
  })
})

describe('run: stopping', () => {
  it('stops on timeoutMs with SIGINT to the group', async () => {
    const result = await run(node, js('setInterval(() => {}, 1000)'), { timeoutMs: 100 })
    expect(result).toMatchObject({ timedOut: true, aborted: false, signal: 'SIGINT' })
  })

  it('treats an AbortSignal.timeout abort as timedOut', async () => {
    const result = await run(node, js('setInterval(() => {}, 1000)'), {
      signal: AbortSignal.timeout(100),
    })
    expect(result).toMatchObject({ timedOut: true, aborted: false, signal: 'SIGINT' })
  })

  it('abort kills the grandchild too, and resolves only after the group is gone', async () => {
    const controller = new AbortController()
    const gc = grandchildPid()
    const pending = run(node, withGrandchild(), {
      signal: controller.signal,
      onStdoutLine: gc.onStdoutLine,
    })
    const pid = await gc.pid
    expect(await isAlive(pid)).toBe(true)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ aborted: true, timedOut: false, signal: 'SIGINT' })
    expect(await isAlive(pid)).toBe(false)
  })

  it('escalates to SIGKILL when the child ignores SIGINT', async () => {
    const controller = new AbortController()
    const gc = grandchildPid()
    const pending = run(node, withGrandchild({ childIgnoresSigint: true }), {
      signal: controller.signal,
      killGraceMs: 200,
      onStdoutLine: gc.onStdoutLine,
    })
    await gc.pid
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ aborted: true, signal: 'SIGKILL' })
  })

  it('SIGKILLs a grandchild that ignores SIGINT after the child already exited', async () => {
    const controller = new AbortController()
    const gc = grandchildPid()
    const pending = run(node, withGrandchild({ grandchildIgnoresSigint: true }), {
      signal: controller.signal,
      killGraceMs: 200,
      onStdoutLine: gc.onStdoutLine,
    })
    const pid = await gc.pid
    controller.abort()
    const result = await pending
    // The child died of SIGINT; 'close' waited for the grandchild holding the pipe.
    expect(result).toMatchObject({ aborted: true, signal: 'SIGINT' })
    expect(await isAlive(pid)).toBe(false)
  })

  it('does not hang when the child exits but a grandchild keeps the pipe open', async () => {
    const gc = grandchildPid()
    const result = await run(node, withGrandchild({ childExits: true }), {
      killGraceMs: 200,
      onStdoutLine: gc.onStdoutLine,
    })
    expect(result).toMatchObject({ exitCode: 0, aborted: false, timedOut: false })
    expect(await isAlive(await gc.pid)).toBe(false)
  })

  it('rejects without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('canceled before start'))
    await expect(run(node, js(''), { signal: controller.signal })).rejects.toThrow(
      'canceled before start',
    )
  })

  it('removes its abort listener, so a later abort is a no-op', async () => {
    const controller = new AbortController()
    const result = await run(node, js(''), { signal: controller.signal })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
    expect(result.aborted).toBe(false)
  })

  it('killActiveGroups SIGKILLs every running group synchronously', async () => {
    const gc = grandchildPid()
    const pending = run(node, withGrandchild({ childIgnoresSigint: true }), {
      onStdoutLine: gc.onStdoutLine,
    })
    const pid = await gc.pid
    killActiveGroups()
    const result = await pending
    expect(result.signal).toBe('SIGKILL')
    expect(await isAlive(pid)).toBe(false)
  })

  it('stops the process and rejects when a line callback throws', async () => {
    const pending = run(node, js("console.log('boom'); setInterval(() => {}, 1000)"), {
      onStdoutLine: () => {
        throw new Error('parser bug')
      },
    })
    await expect(pending).rejects.toThrow('parser bug')
  })
})
