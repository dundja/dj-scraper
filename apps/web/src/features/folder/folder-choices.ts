import { ApiError } from '@/lib/api.ts'
import { describeError, type ErrorDescription } from '@/lib/error-text.ts'

/**
 * The folders the menu offers, newest first: the recent folders, with the current one on top when
 * it isn't among them (the default folder before anything was downloaded into it).
 */
export function folderChoices(folder: string, recentFolders: readonly string[]): string[] {
  return recentFolders.includes(folder) ? [...recentFolders] : [folder, ...recentFolders]
}

/**
 * Words for a failed folder pick or change, or undefined for an abort (the user canceled, or chose
 * another folder while the dialog was open).
 * - 409: our server opens one dialog at a time, and an open one is easy to lose behind the browser.
 * - `folder_unavailable` (the picked folder can't be read or written, e.g. macOS privacy settings):
 *   the server's message says why and what to do. The generic hint ("pick another folder in the
 *   header") would point at this very control, so it is left out.
 * - Anything else as describeError words it (server offline, …).
 */
export function folderProblem(error: unknown): ErrorDescription | undefined {
  if (error instanceof ApiError && error.status === 409) {
    return {
      message: 'A folder dialog is already open.',
      hint: 'It may be behind this window: choose a folder there, or close it and try again.',
    }
  }
  if (error instanceof ApiError && error.code === 'folder_unavailable') {
    return { message: error.message, code: error.code }
  }
  return describeError(error)
}
