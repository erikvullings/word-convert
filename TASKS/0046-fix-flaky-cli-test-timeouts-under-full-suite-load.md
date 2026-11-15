# 0046 Fix flaky CLI test timeouts under full suite load

Status: completed
Priority: medium
Owner: copilot
Agent: Copilot App
Subsystem: testing
Depends on: 0002

## Context

`pnpm test` intermittently fails with `Error: Test timed out in 5000ms` in
`apps/cli` and `apps/web` tests, while the same tests pass when run in isolation
and pass on a rerun of the whole suite. Observed on 2026-11-14 while implementing
0045: three consecutive full runs produced 5, then 4, then 0 failures, and the set
of failing tests differed each time. The failing tests are Markdown/HTML → EPUB
CLI tests (`apps/cli/src/cli.test.ts`, `apps/cli/src/text.test.ts`,
`apps/cli/src/external-images.test.ts`) and one web controller test, none of which
touch the code under change.

The default Vitest `testTimeout` is 5000 ms and the CLI tests invoke the CLI
end to end, so under the parallel load of 54 test files (the run reports ~54
workers spawned at ~250–590 ms each) the slowest spawns exceed the timeout. This
is a test-infrastructure defect, not a product defect, but it costs trust: a red
`pnpm test` cannot be used as a merge signal, and it will be mistaken for a
regression by whoever runs the suite next.

## Acceptance Criteria

- `pnpm test` passes 10 consecutive runs with no flaky failures.
- The fix is scoped to the slow tests rather than raising `testTimeout` globally,
  or, if a global raise is chosen, the reason and value are recorded in
  `vitest.config` with a comment naming this task.
- The CLI tests keep asserting real end-to-end behaviour (exit code, produced
  bytes) — do not convert them into unit tests of argument parsing to make them
  fast.
- If the true cause turns out to be contention on a shared resource (temp
  directory, fixture file, font or model warm-up) rather than raw CPU, fix that
  cause and say so in Agent Notes.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass.

## Implementation Notes

- Reproduce reliably with load rather than hoping to see it: run the full suite in
  a loop, or run the CLI test files together with the whole suite's worker count
  (`npx vitest run` on the repository) rather than only `npx vitest run apps/cli`,
  which passes consistently in isolation.
- Candidates to measure before changing anything: per-test timeout for the
  `invoke()`-style CLI helpers, cold-start cost of the CLI entry per test (a
  warm-up or a single shared build), worker count, and any shared temp directory
  under `apps/cli/src/*.test.ts`.
- Keep determinism guarantees intact: tests use `fixedDate`-style fixed
  conversion dates and must not gain any wall-clock or network dependence.

## Agent Notes

- 2026-11-14 pi: Opened while implementing 0045. `apps/cli` alone: 175 passed on
  three consecutive runs. Whole suite: 5, then 4, then 0 failures, all with
  `Test timed out in 5000ms`, always in different `apps/cli`/`apps/web` files.
  Example: `apps/cli/src/cli.test.ts > CLI arguments and output > defaults to EPUB
  even when streaming output`. No product code change was involved in the runs
  that failed.
- 2026-11-15 Copilot: Scoped 15-second timeouts to the CLI and controller test
  files that run conversions or asynchronous worker transitions; external-image
  CLI integration cases have per-test timeouts. The global Vitest timeout is
  unchanged. Ten consecutive `pnpm test --reporter=append-only` full-suite runs
  passed, each with 58 test files passed, 2 skipped, 900 tests passed, and 4
  skipped.
