---
name: implement
description: Implement a DJ Scraper roadmap item or feature end to end, from understanding it through planning, building, testing, verifying and reviewing to updating the docs.
argument-hint: "[roadmap item or feature; empty = next open roadmap item]"
disable-model-invocation: true
---

Target: $ARGUMENTS
If the target is empty, take the first unchecked item in `docs/roadmap.md`.

1. **Understand.** Read the roadmap entry, the relevant parts of `docs/product.md` and `docs/architecture.md`, and the code it touches. If the item is ambiguous or conflicts with `docs/decisions.md`, ask before building.
2. **Plan.** List the files to create or change, any contract changes in `packages/shared`, and the tests you'll write. For cross-package work, define the shared Zod schemas first.
3. **Build** in small steps that typecheck. Delegate when it helps: `ytdlp-specialist` for engine/yt-dlp work, `ui-engineer` for UI, `test-engineer` for test suites and fixtures. Independent pieces can run in parallel.
4. **Test.** Unit tests for logic, integration tests against the fake engine for server flows, and a browser check for UI flows.
5. **Verify.** Run the `verify` skill until everything is green.
6. **Review.** Run the `code-reviewer` agent on the diff and fix blockers and majors.
7. **Document.**
   - Tick the roadmap item and add follow-ups as new unchecked items.
   - Update `docs/architecture.md` and `docs/product.md` if behavior or design changed.
   - Add an ADR to `docs/decisions.md` for any new decision.
   - Keep the commands and layout in `CLAUDE.md` accurate.
8. **Report** what changed, how it was verified, and any open questions. Don't commit unless asked.
