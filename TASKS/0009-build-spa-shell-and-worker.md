# 0009 Build SPA shell and worker

Status: done
Priority: high
Owner: unassigned
Agent: codex
Area: frontend
Depends on: 0006, 0007, 0008

## Context

Create the Mithril SPA workflow shell and thin worker adapter around the tested core packages.

## Acceptance Criteria

- Mithril and mithril-materialized implement the eight workflow stages with responsive light/dark themes.
- Accessible file selection and drag-and-drop accept safe DOCX input and clearly state that processing is local.
- Worker transfers buffers, reports progress, supports cancellation, returns structured errors, and cleans up resources.
- No conversion logic is duplicated in UI/worker code and no document content is persisted locally.
- Initial end-to-end flow can analyze a fixture and download HTML or Markdown.

## Implementation Notes

- Store only preferences and mapping presets locally.
- Keep application state explicit and serializable across workflow stages.

## Agent Notes

- Next step: establish state/actions and worker protocol before building detailed editors.
- 2026-07-15 codex: Built the responsive Mithril and mithril-materialized eight-stage SPA shell with accessible DOCX file/drop intake, explicit serializable state, light/dark/system themes, local-only privacy messaging, preferences/mapping-preset-only persistence, progress/cancel/error UI, and standalone HTML or Markdown downloads. Added a thin typed worker protocol/runtime that transfers input/output buffers, delegates to the existing reader/writers, reports progress, handles cancellation and private structured errors, and cleans up operation state. Added 8 focused tests across state, shell, and real fixture-to-output worker integration; verified those exact tests, the full workspace suite, all workspace/browser/worker typechecks, zero-warning lint, formatting, production build, `git diff --check`, and interactive browser checks at desktop/mobile widths and dark mode with no console warnings. Known limitation: detailed style/metadata/formula/cover editors and rich preview content remain intentionally assigned to tasks 0010–0014.
