# Statekeep — Claude Code Instructions

## Project

Statekeep is a local-first desktop app for structured project management.
Electron + TypeScript + Svelte 5 + Tailwind + electron-vite.

See `docs/ARCHITECTURE.md` for the full technical spec.
See `docs/ROADMAP.md` for the phase plan.

## Commands

<!-- Fill in once Phase 1 scaffold is wired up -->

```bash
# Development
bun run dev          # start electron-vite dev server with HMR

# Build
bun run build        # production build

# Tests
bun run test         # run all tests (Vitest)
bun run test:e2e     # Playwright E2E tests

# Type check
bun run typecheck    # tsc --noEmit
```

## Testing

Framework: **Vitest** (unit + integration) + **Playwright** (E2E)

- Unit tests live in `tests/unit/`
- E2E tests live in `tests/e2e/`
- Test fixtures (sample project-document JSON files) in `tests/fixtures/`
- Git service tests use real git repos in temp directories, never mocks
- Diff engine gets the heaviest unit test coverage (it is the core differentiator)

## Key architecture rules

- Renderer never touches the filesystem directly. All mutations go through IPC.
- All IPC channels are defined in `src/shared/ipc.ts` before implementation.
- All git CLI calls use `execFile`, never `exec`.
- Validation functions live in `src/shared/validation.ts`. Never duplicate them.
- Error codes live in `src/shared/errors.ts`. Use `SCREAMING_SNAKE` constants.
- All IPC responses use `Result<T>` — never throw across the IPC boundary.

## CI policy (read before adding `.github/workflows/`)

Do not let Windows or macOS jobs
(`windows-*`, `macos-*` runners) trigger automatically on every push or PR —
GitHub bills those at 2x/10x the Linux rate, and `vpp3_electron` blew through
its monthly Actions-minutes allowance in ~12 days doing exactly that (daily
full-matrix cron stacked on top of a per-push Windows job). Fixed there by
making Windows/macOS opt-in only via a PR label (e.g. `ci:full`) — see
`vpp3_electron`'s `.github/scripts/classify-ci-paths.mjs`, `pr-ci.yml`, and
`cross-platform-smoke.yml` for the reference implementation.

- Ubuntu-hosted runners are 1x and fine to run on every push/PR by default.
- Windows/macOS: gate behind an opt-in label or a manual/tag trigger, never
  path-based auto-triggering on every push.
- If Windows/macOS coverage becomes frequent enough that opt-in gating is
  itself the bottleneck, self-hosted runners are the next lever — but they
  are registered per-repo, not shared. `vpp3_electron`'s runners
  (`mac-mini-always-on`, `XIDAX`) are scoped to that repo only and cannot be
  pointed at Statekeep; a separate registration would be needed here.
