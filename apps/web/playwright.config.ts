import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * The e2e server's port: neither 4747 (`pnpm start`) nor 5173 (`pnpm dev`), so e2e runs beside a
 * running app. The guard accepts exactly 127.0.0.1:<port> and localhost:<port> as Host.
 */
const PORT = 4849
const ORIGIN = `http://127.0.0.1:${PORT}`

/**
 * e2e builds the UI into its own directory: apps/web/dist is what `pnpm start` serves, and a build
 * there would empty it under a running app. Inside node_modules, so git and Biome ignore it.
 */
const E2E_DIST = 'node_modules/.e2e-dist'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  // One test at a time, browsers included: they share the one server, whose settings, downloads,
  // download pacing and files outlive a test (see e2e/fake-urls.ts).
  workers: 1,
  // The report goes to the gitignored playwright-report/; never start its server on a failure.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  // WebKit stands in for Safari, whose quirks matter here (docs/architecture.md, Security model).
  // Firefox is left out for now.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Builds the UI first, however Playwright is started (script, `playwright test`, an editor), then
  // runs the real server in production mode on that build with the fake engine, which resolves and
  // downloads the URLs in e2e/fake-urls.ts. Nothing here touches the network. Vite runs through
  // node, so this works without node_modules/.bin on PATH.
  webServer: {
    command: `node node_modules/vite/bin/vite.js build --outDir ${E2E_DIST} --logLevel warn && node ../server/test/e2e-server.ts`,
    env: {
      PORT: String(PORT),
      DJS_WEB_DIST: fileURLToPath(new URL(`./${E2E_DIST}`, import.meta.url)),
    },
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // SIGTERM, not Playwright's default SIGKILL, so the server can stop its engine process groups.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
