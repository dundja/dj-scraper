import { test as base, expect } from '@playwright/test'

/**
 * `test` for every spec: a console error or warning, or an uncaught page error, fails the test that
 * caused it, as in the unit tests (src/test/setup.ts).
 */
export const test = base.extend<{ consoleGuard: undefined }>({
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = []
      page.on('console', (message) => {
        const type = message.type()
        if (type === 'error' || type === 'warning')
          problems.push(`console.${type}: ${message.text()}`)
      })
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
      await use(undefined)
      expect(problems, 'console errors, warnings or page errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
