# 0009 Build SPA shell and worker

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
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
