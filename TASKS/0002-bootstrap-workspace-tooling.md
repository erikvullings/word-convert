# 0002 Bootstrap workspace tooling

Status: done
Priority: high
Owner: unassigned
Agent: codex
Area: tooling
Depends on: 0001

## Context

Create the pnpm/Vite/TypeScript workspace and shared quality tooling on which all packages depend.

## Acceptance Criteria

- pnpm workspace contains `apps/web` and the required package directories.
- Strict TypeScript, modern ESM, Vitest, formatting, linting, and type-check scripts run from the root.
- Configuration avoids deprecated TypeScript features and remains suitable for the TypeScript 7 native compiler.
- Vite development and production builds work with a configurable GitHub Pages base.

## Implementation Notes

- Target current and previous major Chrome, Edge, Firefox, and Safari versions.
- Add dependency versions deliberately and document runtime/toolchain requirements.
- Do not add Playwright by default.

## Agent Notes

- Next step: scaffold the smallest compiling workspace and verify every root script.
- 2026-07-14 codex: Started implementation. Scope is tooling, workspace boundaries, and a compiling Mithril shell; domain contracts and conversion behavior remain in 0003 onward.
- 2026-07-14 codex: Completed pnpm workspace with `apps/web`, eight core/shared packages, test fixture directories, strict TypeScript 7 configs, separate DOM/worker programs, Vite, Vitest, Prettier, and oxlint. Added a configurable Pages base and documented the toolchain in `docs/tooling.md`. Replaced `typescript-eslint` after its peer range rejected TypeScript 7; `pnpm peers check`, formatting, linting, type checking, tests, default/root-base builds, and a live local Vite fetch all pass. The first formatter run normalized Markdown layout in `REQUIREMENTS.md` and task files without changing content; Markdown is now excluded from formatting.
