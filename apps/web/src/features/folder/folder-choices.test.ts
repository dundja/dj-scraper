import { CancelledError } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import { folderChoices, folderProblem } from './folder-choices.ts'

describe('folderChoices', () => {
  it('offers the recent folders as they are when the current one is among them', () => {
    expect(folderChoices('/Volumes/USB', ['/Users/dj/Music', '/Volumes/USB'])).toEqual([
      '/Users/dj/Music',
      '/Volumes/USB',
    ])
  })

  it('puts the current folder on top when it is not a recent one', () => {
    expect(folderChoices('/Users/dj/Music/DJ Scraper', ['/Volumes/USB'])).toEqual([
      '/Users/dj/Music/DJ Scraper',
      '/Volumes/USB',
    ])
    expect(folderChoices('/Users/dj/Music/DJ Scraper', [])).toEqual(['/Users/dj/Music/DJ Scraper'])
  })

  it('returns a copy, never the settings array itself', () => {
    const recent = Object.freeze(['/Volumes/USB'])
    const choices = folderChoices('/Volumes/USB', recent)
    expect(choices).toEqual(recent)
    expect(choices).not.toBe(recent)
  })
})

describe('folderProblem', () => {
  it('explains a 409: a dialog is already open, maybe behind the browser', () => {
    const error = new ApiError({
      kind: 'api',
      status: 409,
      code: 'invalid_request',
      message: 'A folder picker is already open',
    })
    expect(folderProblem(error)).toEqual({
      message: 'A folder dialog is already open.',
      hint: 'It may be behind this window: choose a folder there, or close it and try again.',
    })
  })

  it("keeps the server's words for a folder it can't use, without pointing back at the picker", () => {
    const error = new ApiError({
      kind: 'api',
      status: 422,
      code: 'folder_unavailable',
      message: "That folder is inside DJ Scraper's own data folder. Choose another one.",
    })
    expect(folderProblem(error)).toEqual({
      message: "That folder is inside DJ Scraper's own data folder. Choose another one.",
      code: 'folder_unavailable',
    })
  })

  it('says the server is offline, and how to start it', () => {
    vi.stubEnv('DEV', true)
    const error = new ApiError({
      kind: 'unreachable',
      message: "Can't reach the DJ Scraper server.",
    })
    expect(folderProblem(error)).toEqual({
      message: "Can't reach the DJ Scraper server.",
      hint: 'Start it with `pnpm dev` in the project folder.',
    })
  })

  it("passes other server errors through with their code's hint", () => {
    const error = new ApiError({
      kind: 'api',
      status: 403,
      code: 'forbidden',
      message: 'Origin not allowed',
    })
    expect(folderProblem(error)).toMatchObject({ message: 'Origin not allowed', code: 'forbidden' })
    expect(folderProblem(error)?.hint).toContain('Open DJ Scraper at the address')
  })

  it('says nothing for an abort: the user canceled or chose another folder', () => {
    expect(folderProblem(new DOMException('The operation was aborted.', 'AbortError'))).toBe(
      undefined,
    )
    expect(folderProblem(new CancelledError())).toBe(undefined)
  })
})
