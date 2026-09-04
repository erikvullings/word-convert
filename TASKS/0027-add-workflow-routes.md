# 0027 Add workflow routes

Status: done
Priority: high
Subsystem: frontend
Depends on: 0009

## Context

Workflow navigation currently relies on anonymous browser history entries and
direct `state.stage` mutations. The URL does not identify the output-format or
conversion screen, so back/forward navigation is unreliable.

## Acceptance Criteria

- Canonical base-path-safe routes exist for document selection, output-format
  selection, Markdown conversion, HTML conversion, and EPUB conversion.
- Selecting a format and choosing another format update both application state
  and the URL without depending on the previous history entry.
- Browser back/forward restores the matching stage and output format when a
  document is loaded.
- A conversion route opened without an in-memory document safely returns to the
  document route because source buffers are intentionally not persisted.
- Route parsing and controller navigation have focused regression coverage.

## Implementation Notes

- Keep routing in the existing controller lifecycle; do not introduce a second
  application state owner.
- Preserve custom `WORDCONVERT_BASE_PATH` deployments.

## Agent Notes

- 2026-09-04 GitHub Copilot: Started from the existing `popstate` handler and
  direct stage mutations in `app.ts` and `controller.ts`.
- 2026-09-04 GitHub Copilot: Added base-path-safe routes for `/`,
  `/output-format`, `/markdown`, `/html`, and `/epub`; controller-owned
  push/replace/popstate synchronization; explicit output-format navigation; and
  a generated GitHub Pages `404.html` fallback. Fresh conversion URLs normalize
  to document selection because source bytes are intentionally memory-only.
  Validation: 338 tests passed, 2 skipped; type-check, lint, formatting,
  production build, and static PWA verification passed.