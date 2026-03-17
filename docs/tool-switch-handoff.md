# Tool Switch Handoff

## Context

- Goal: Continue PR1 (foundation baseline + domain model) after tool switch.
- Current blocker: `apply_patch` fails in this repository with:
  - `windows sandbox: setup refresh failed with status exit code: 1`
- Same tool session can still read/write files with shell commands.

## Current Workspace State

- Modified file:
  - `src/app/components/player/player.cy.tsx`
- New, untracked directories/files:
  - `docs/foundation-phase-tasklist.md`
  - `docs/foundation-phase-baseline.md`
  - `src/domain/**` (entities, ids, source/backend types, navidrome mapper)

## Completed Work

- Added Japanese planning/task docs:
  - `docs/foundation-phase-tasklist.md`
  - `docs/foundation-phase-baseline.md`
- Added initial domain layer:
  - `src/domain/media-source.ts`
  - `src/domain/playback-backend.ts`
  - `src/domain/id.ts`
  - `src/domain/entities/{album,artist-credit,playlist,queue-item,track}.ts`
  - `src/domain/mappers/navidrome/index.ts`
  - `src/domain/index.ts`
- Added regression safety test:
  - `src/app/components/player/player.cy.tsx`
  - New test verifies queue next/previous index and track-title updates.

## Remaining Tiny Tasks (for PR1)

1. Add mapper barrel file:
   - Create `src/domain/mappers/index.ts` with:
   - `export * as navidromeMappers from './navidrome'`
2. Export mappers from domain index:
   - Update `src/domain/index.ts` to add:
   - `export * from './mappers'`

## Suggested Exact Patch Sequence

1. Add `src/domain/mappers/index.ts`.
2. Update `src/domain/index.ts`.
3. Run:
   - `git status --short`
   - `git diff --check`
4. If tooling exists, run:
   - `npm run build`
   - `npm run lint`

## Notes About Validation

- In this environment, `npm run build` previously failed at `vite not recognized`.
- `npm run lint` previously failed at `biome not recognized`.
- If that remains true, at minimum keep diff clean and rely on CI or another machine for full verification.

## Why This File Exists

- This handoff is intentionally explicit so another tool/session can continue immediately
  without re-discovering context or re-spending tokens on history reconstruction.
