# packages/shared: the API contract

Zod schemas and inferred types shared by `apps/web` and `apps/server`, plus small pure helpers (e.g. `classifyUrl`, duration formatting). Every request, response and SSE event shape is defined here and nowhere else.

## Rules
- The only runtime dependency is `zod`. No Node or DOM APIs: this code runs in the browser and on the server.
- Naming: `export const TrackSchema = z.object({ … })` plus `export type Track = z.infer<typeof TrackSchema>`.
- Use discriminated unions for variants: `ResolveResult` by `kind`, SSE events by `type`, errors by `code`.
- A schema change is a contract change. Update server handlers, web usages and their tests in the same change.
- The package is consumed as TypeScript source through the `exports` field in `package.json`, with no build step.
- Every helper has unit tests (`*.test.ts` next to the source).
