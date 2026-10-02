---
name: verify
description: Run DJ Scraper's quality gate (Biome, TypeScript typecheck, tests) and fix what fails. Use before declaring any coding task done, or when asked to verify, check or validate the code. An optional argument limits it to one package (web, server, shared).
argument-hint: "[web|server|shared]"
---

Quality gate for DJ Scraper. Scope: `$ARGUMENTS`. Empty means the whole repo. Otherwise run each step as `pnpm --filter @dj-scraper/$ARGUMENTS <script>`, except Biome, which is scoped by path: `pnpm check <apps/web|apps/server|packages/shared>`.

If there's no root `package.json` yet, say the workspace isn't scaffolded (roadmap Phase 0) and stop.

Run these in order, and fix each failure before moving on:
1. `pnpm check`: Biome lint and format (`pnpm check:fix` applies the safe fixes).
2. `pnpm typecheck`
3. `pnpm test`: unit and integration tests, no network.
4. `pnpm test:e2e`, unless only docs changed. It builds the UI and runs it against the real server (`apps/server/test/e2e-server.ts`), so changes in `apps/web`, `apps/server` or `packages/shared` can all break it. Always run the root script, even when scoped to server or shared: only `@dj-scraper/web` has it. If the browsers are missing, `pnpm test:e2e:install` downloads them (network, so run it by hand).

Fix root causes. Don't silence anything (`@ts-ignore`, `biome-ignore`, `.skip`, loosened assertions) unless the user agrees. If a failure is unrelated to the current change, report it instead of fixing it.

Finish with a short report: each step ✅/❌, what you fixed, and what's left.
