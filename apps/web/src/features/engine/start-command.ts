/**
 * The command that runs the app the way this page was served, for messages that say how to start
 * or restart it: Vite's dev server under `pnpm dev`, the server's built UI under `pnpm start`.
 * Read at call time, so tests can stub `import.meta.env.DEV`; a build inlines it.
 */
export function startCommand(): string {
  return import.meta.env.DEV ? 'pnpm dev' : 'pnpm start'
}
