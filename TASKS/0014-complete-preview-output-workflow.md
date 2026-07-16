# 0014 Complete preview and output workflow

Status: done
Priority: high
Owner: unassigned
Agent: unassigned
Area: frontend
Depends on: 0010, 0012, 0013

## Context

Complete configuration, previews, warnings, conversion, and downloads for every requested format.

## Acceptance Criteria

- Output settings expose Markdown, HTML, EPUB, formula, asset, and cover options with sensible defaults.
- Sanitized HTML preview, Markdown preview, EPUB structure summary, progress, cancellation, and warnings are complete.
- DOMPurify sanitizes preview insertion and a restrictive policy prevents remote/active content.
- Every requested download mode produces correctly named files without uploading or retaining source data.
- Workflow supports reruns after metadata, style, formula, cover, or output changes.

## Implementation Notes

- Revoke object URLs and clear large buffers as soon as they are no longer needed.
- Make warning navigation lead users to the relevant editor or output setting.

## Agent Notes

- Next step: enumerate output option combinations and test each through the worker boundary.
- 2026-07-16 codex: Completed typed Markdown, HTML, EPUB, formula, asset, and cover settings with standalone/single-file and generated-folder ZIP modes; added sanitized HTML/Markdown and EPUB package previews, propagated navigable warnings, preserved progress/cancellation and reruns across editor/output changes, and released object URLs and large output buffers after download. Added 16 task-specific tests across output defaults/naming, both ZIP modes through the worker boundary, packaged previews, restrictive remote/active-content policy, warning destinations, and download cleanup; verified their exact files, the full 118-test workspace suite, every strict TypeScript configuration, zero-warning lint, production build, `git diff --check`, and the local browser shell with no console errors. No known limitations within this task's scope.
