# packages/shared: the API contract

Zod schemas and inferred types shared by `apps/web` and `apps/server`, plus small pure helpers and constants both sides need: `healthProblems` (engine problems in words), `allowedByFetchMetadata` (the guard's cross-site rule, also used by the Vite dev server), `SECURITY_HEADERS` (sent by the server and the Vite dev server), `PortSchema` and `loopbackHosts`, the engine minimums in `engine.ts`, `classifyUrl` (a pasted URL → platform, kind and badge, or a rejection), `splitArtistTitle`, and later duration formatting. Every request, response and SSE event shape is defined here and nowhere else.

## Rules
- The only runtime dependency is `zod`. No Node or DOM APIs: this code runs in the browser and on the server. The WHATWG `URL`/`URLSearchParams` globals are declared by hand in `src/globals.d.ts` (never import it); use only the members declared there.
- Naming: `export const TrackSchema = z.object({ … })` plus `export type Track = z.infer<typeof TrackSchema>`. Import Zod as `import * as z from 'zod'`.
- Layout: one file per domain area (`track.ts`, `collection.ts`, `errors.ts`, …), each re-exported from `src/index.ts`.
- Use discriminated unions for variants: `ResolveResult` by `kind`, collection entries by `partial`, SSE events by `type`. Errors are `ErrorInfo` (`{ code, message }`); give a code its own union member only when it needs extra payload.
- Optional fields are omitted, never `null` or `''` (both are rejected). The server's normalizers drop such values instead of failing the whole response.
- A schema change is a contract change. Update server handlers, web usages and their tests in the same change.
- The package is consumed as TypeScript source through the `exports` field in `package.json`, with no build step. Node loads it through pnpm's workspace symlink and refuses to strip types under `node_modules`, so never enable `injectWorkspacePackages` or `--preserve-symlinks`.
- Every helper has unit tests (`*.test.ts` next to the source).
