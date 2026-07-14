# 0014 Complete preview and output workflow

Status: open
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
