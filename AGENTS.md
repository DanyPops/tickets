# Development Rules

Two packages: `tickets` (the daemon -- backends, RPC service, SQLite storage, a real
`VehicleRegistry`) and `pi-tickets` (the Pi extension -- connects as a `VehicleClient`,
projects real ticket operations as Pi tools via `@danypops/vehicle-client-pi`). See
`@danypops/vehicle`'s own AGENTS.md for the shared substrate both build on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "confirmed
  live") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable.
- Read a file in full before a wide-ranging change to it.
- A passive Pi lifecycle hook (`session_start`, a background poll) must never surprise-spawn the
  tickets daemon -- only an explicit user/LLM action does (the `/tickets` command, or a real
  tool call). `resolveVehicleClientTarget` only reads the handle file if the daemon has already
  started; keep that invariant when adding a new passive hook.
- `TICKETS_TOOL_PREFIXES` (pi-tickets/src/vehicle-client.ts) must list every namespace prefix a
  Vehicle-projected tool can start with -- a new operation family needs its prefix added here
  too, or `isTicketsVehicleTool()` silently stops recognizing its own tools.
- `ISSUE_ACTION_ALIAS` needs an entry for every `issue.*` operation that render.ts's own action
  vocabulary switches on -- a missing alias silently falls through to the underscored form with
  no matching render branch.

## Commands

- Per-package: `cd packages/<pkg> && bun run typecheck`, `bun test` (pi-tickets caps
  `--max-concurrency 1` -- keep that when adding tests; a real daemon + real port per test file
  doesn't tolerate unbounded parallelism).
- Whole workspace: `bun run typecheck` (`bun run --filter '*' typecheck`), `bun run test`
  (`bun run --cwd packages/tickets test && bun run --cwd packages/pi-tickets test`), `bun run
  lint` (`biome check --write . && eslint packages --max-warnings 0`).
- Run the touched package's typecheck + test after every change, then the workspace-wide
  typecheck before considering a change done.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` is a `peerDependency` of `pi-tickets`, not a plain `dependency`
  -- it holds shared mutable module-level state (the Vehicle Shell registry, activity broker)
  that must exist as exactly one copy in the process. Never downgrade it back to `dependency`.
- Before trusting a test result, confirm the workspace's own declared dependency floor for a
  sibling package (e.g. `@danypops/vehicle-client-pi`) actually covers that sibling's current
  local version -- a stale floor makes bun silently resolve an old published copy instead of
  linking local source, and every test since then exercised the wrong code.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH for a backward-compatible change), typecheck +
  test + lint locally, commit, push, then tag and push the tag. `@danypops/tickets` uses a bare
  `v<version>` tag; `@danypops/pi-tickets` uses `pi-tickets-v<version>` -- see
  `.github/workflows/publish.yml`'s own tag-to-package-directory matching. Push tags one at a
  time, never batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking

- Work here is tracked in the shared Papyrus task database (project root: this repo's own
  directory). `tasks.start` → implement → `tasks.set_gates` (a real, re-runnable command proving
  the fix) → `tasks.submit` → `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.
