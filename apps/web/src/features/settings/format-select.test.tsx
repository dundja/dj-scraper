import { type Settings, SettingsSchema } from '@dj-scraper/shared'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Label } from '@/components/ui/label.tsx'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { FORMAT_OPTIONS, formatLabel, ORIGINAL_FORMAT_DESCRIPTION } from './format-options.ts'
import { FormatSelect } from './format-select.tsx'
import { settingsQueryKey } from './use-settings.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

const saved = (changes: Partial<Settings>): Settings =>
  SettingsSchema.parse({ ...settings, ...changes })

function trigger(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Format' })
}

/** The format the trigger shows (the chevron icon carries a stray text node, so not textContent). */
function shown(): string | null | undefined {
  return trigger().querySelector('[data-slot="select-value"]')?.textContent
}

/** Renders the select once the settings have loaded (the trigger shows the saved format). */
async function renderLoaded(current: Partial<Settings> = {}) {
  server.on('GET /api/settings', () => json(saved(current)))
  const rendered = renderWithQueryClient(<FormatSelect />)
  await waitFor(() => expect(trigger().getAttribute('data-disabled')).toBeNull())
  return rendered
}

describe('FormatSelect', () => {
  it('shows the saved format', async () => {
    await renderLoaded({ format: 'm4a' })
    expect(shown()).toBe('M4A (AAC)')
  })

  it('is disabled with a placeholder until the settings load', () => {
    server.on('GET /api/settings', noAnswer)
    renderWithQueryClient(<FormatSelect />)

    expect(shown()).toBe('Format')
    expect(trigger().hasAttribute('data-disabled')).toBe(true)
  })

  it('lists every format with a one-line description', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(trigger())

    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'MP3',
      'M4A (AAC)',
      'AIFF',
      'WAV',
      'FLAC',
      'Original',
    ])
    const descriptions = options.map((option) => {
      const id = option.getAttribute('aria-describedby') ?? ''
      return document.getElementById(id)?.textContent
    })
    expect(descriptions).toEqual(FORMAT_OPTIONS.map((option) => option.description))
    expect(screen.getByRole('option', { name: 'MP3' }).getAttribute('aria-selected')).toBe('true')
  })

  it('promises no bitrate or quality the source may not have (every stream is lossy)', async () => {
    await renderLoaded({ format: 'mp3' })

    // Beside "Source: MP3 128 kbps", whose file stays 128 kbps: the closed select names no bitrate.
    expect(shown()).toBe('MP3')
    for (const option of FORMAT_OPTIONS) expect(option.label).not.toMatch(/kbps/)
    expect(FORMAT_OPTIONS.find((option) => option.value === 'mp3')?.description).toBe(
      '320 kbps when converted; an MP3 source keeps its own bitrate.',
    )
    // A lossless format holds what the stream had, no more.
    const lossless = FORMAT_OPTIONS.filter((option) => /lossless/i.test(option.description))
    expect(lossless.map((option) => option.value)).toEqual(['aiff', 'wav', 'flac'])
    for (const option of lossless) {
      expect(option.description).toMatch(
        /^Lossless container\b.*: the source's quality, no more\.$/,
      )
    }
  })

  it('says that Original converts nothing and has no artwork from YouTube', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(trigger())

    const original = await screen.findByRole('option', { name: 'Original' })
    expect(original.textContent).toContain(ORIGINAL_FORMAT_DESCRIPTION)
    expect(ORIGINAL_FORMAT_DESCRIPTION).toMatch(/No conversion/)
    expect(ORIGINAL_FORMAT_DESCRIPTION).toMatch(/no artwork/)
  })

  it('saves a new pick and shows it at once', async () => {
    const user = userEvent.setup()
    const reply = Promise.withResolvers<Response>()
    server.on('PUT /api/settings', () => reply.promise)
    const { queryClient } = await renderLoaded()

    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'AIFF' }))

    expect(shown()).toBe('AIFF')
    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ format: 'aiff' })

    reply.resolve(json(saved({ format: 'aiff' })))
    await waitFor(() => expect(queryClient.getQueryData(settingsQueryKey)?.format).toBe('aiff'))
    expect(shown()).toBe('AIFF')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('picks with the keyboard', async () => {
    const user = userEvent.setup()
    server.on('PUT /api/settings', () => json(saved({ format: 'flac' })))
    await renderLoaded()

    await user.tab()
    expect(document.activeElement).toBe(trigger())
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    // Typeahead goes by the option's label, not its description.
    await user.keyboard('fl')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('option', { name: 'FLAC' })),
    )
    await user.keyboard('{Enter}')

    await waitFor(() => expect(shown()).toBe('FLAC'))
    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ format: 'flac' })
  })

  it('sends nothing when the saved format is picked again', async () => {
    const user = userEvent.setup()
    await renderLoaded({ format: 'wav' })

    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'WAV' }))

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(server.callsTo('PUT /api/settings')).toHaveLength(0)
  })

  it('goes back to the saved format and says why when the server refuses the change', async () => {
    const user = userEvent.setup()
    server.on('PUT /api/settings', () =>
      json({ error: { code: 'invalid_request', message: 'Settings are read-only.' } }, 400),
    )
    await renderLoaded()

    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'WAV' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Format not saved: Settings are read-only.')
    expect(shown()).toBe(formatLabel('mp3'))
  })

  it('drops the note once a later pick is saved', async () => {
    const user = userEvent.setup()
    server.on('PUT /api/settings', () =>
      json({ error: { code: 'invalid_request', message: 'Settings are read-only.' } }, 400),
    )
    await renderLoaded()
    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'WAV' }))
    await screen.findByRole('alert')

    server.on('PUT /api/settings', () => json(saved({ format: 'flac' })))
    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'FLAC' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(shown()).toBe('FLAC')
  })

  it('can be disabled by its owner, e.g. while a download is being queued', async () => {
    server.on('GET /api/settings', () => json(settings))
    const { queryClient } = renderWithQueryClient(<FormatSelect disabled />)
    await waitFor(() => expect(queryClient.getQueryData(settingsQueryKey)).toBeDefined())

    expect(shown()).toBe('MP3')
    expect(trigger().hasAttribute('data-disabled')).toBe(true)
  })

  it('takes an id for a visible label, and classes for the trigger', async () => {
    server.on('GET /api/settings', () => json(settings))
    renderWithQueryClient(
      <div>
        <Label htmlFor="format">Download as</Label>
        <FormatSelect id="format" className="w-44" />
      </div>,
    )

    const select = await screen.findByRole('combobox', { name: 'Format' })
    expect(select.id).toBe('format')
    expect(select.className).toContain('w-44')
    expect(within(document.body).getByText('Download as').getAttribute('for')).toBe('format')
  })
})
