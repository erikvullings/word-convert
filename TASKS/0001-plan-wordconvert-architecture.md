# 0001 Plan WordConvert architecture

Status: done
Priority: high
Owner: unassigned
Agent: codex
Area: architecture
Depends on: none

## Context

Turn `REQUIREMENTS.md` into a complete implementation plan for a privacy-preserving static SPA. The repository contains no reusable application code.

## Acceptance Criteria

- Architecture boundaries, delivery sequence, dependencies, and verification gates are represented by resumable tasks in `TASKS/`.
- Decisions record pnpm, MIT, `erikvullings/word-convert`, and current plus previous major browser support.
- The plan covers the complete requested scope rather than a reduced MVP.

## Implementation Notes

- Use a pnpm workspace with `apps/web` and framework-independent packages.
- Use `/word-convert/` as the production Vite base; verify the repository's canonical casing before first deployment.
- Core packages exchange serializable plain data and must not access browser globals.
- Deliver in vertical slices, keeping security limits and deterministic behavior inside core APIs.
- Use mithril-materialized's light/dark theming without a custom brand palette initially.

## Agent Notes

- 2026-07-14 codex: Read all of `REQUIREMENTS.md`; no reusable source exists. Created tasks 0002–0017 as the implementation plan based on the user's answers.
