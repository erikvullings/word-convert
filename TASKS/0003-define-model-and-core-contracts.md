# 0003 Define model and core contracts

Status: done
Priority: high
Owner: erikvullings
Agent: codex
Area: architecture
Depends on: 0002

## Context

Define the stable semantic boundary shared by DOCX readers, writers, the worker, and a future Rust/WASM reader.

## Acceptance Criteria

- `DocumentModel` represents metadata with provenance/confidence, blocks, inlines, assets, equations, notes, styles, and warnings.
- `DocxReader`, writer, progress, cancellation, validation, and structured-error contracts are documented and tested.
- All cross-package values are plain serializable data; binary fields use explicit typed-array conventions.
- Core packages compile and test in Node without DOM or Mithril dependencies.

## Implementation Notes

- Avoid classes and implicit dates at package boundaries.
- Specify schema/version evolution and the expected future WASM boundary.
- Make conversion date/time inputs injectable so tests and output remain deterministic.

## Agent Notes

- Next step: settle discriminated unions and serialization tests before parser implementation.
- 2026-07-14: Started implementation. Contracts will live in `@wordconvert/document-model` so readers, writers, workers, and a future WASM adapter share one dependency-free boundary. Binary model fields use `Uint8Array`; explicit JSON serialization converts them to tagged byte arrays.
- 2026-07-14: Completed the versioned `DocumentModel` and reader/writer, progress, cancellation, validation, error, and JSON binary contracts in `packages/document-model/src/index.ts`. Added six Node tests in `packages/document-model/src/index.test.ts` and documented evolution, deterministic dates, privacy constraints, typed-array handling, and the WASM adapter boundary in `docs/core-contracts.md`. Kept tests out of the package production typecheck so its ES-only library boundary remains free of Vitest's browser-global declarations. Verified focused typecheck/tests plus workspace typecheck, tests, lint, formatting, and production build.
