# 0003 Define model and core contracts

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
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
