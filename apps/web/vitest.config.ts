import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so test runs never regenerate src/routeTree.gen.ts (router plugin)
// or compile Tailwind; tests that need routes build them in memory.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Root-level *.test.ts cover the Node-side dev config and pick the node environment per file.
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    // Tests replace fetch with vi.stubGlobal (src/test/fake-api.ts); put the real one back after each.
    unstubGlobals: true,
  },
})
