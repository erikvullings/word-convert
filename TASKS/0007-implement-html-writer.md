# 0007 Implement HTML writer

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
Area: html-writer
Depends on: 0003, 0005

## Context

Generate semantic HTML independently from the model for downloads and as the reference renderer for preview.

## Acceptance Criteria

- Writer produces deterministic standalone HTML with embedded CSS/assets and an automatic heading-based table of contents.
- Optional HTML ZIP contains safe POSIX asset paths, CSS, fonts, and images.
- Output is script-free, offline, printable, accessible, and supports reader light/dark preferences.
- Links, metadata, XML/HTML escaping, and assets are sanitized against active content and remote loading.
- Structural tests cover all supported model nodes and hostile input.

## Implementation Notes

- Expose a preview fragment/output mode reusable by the SPA; DOMPurify remains a browser-bound final defense for insertion.

## Agent Notes

- Next step: implement a minimal semantic serializer and deterministic asset registry.
