# 0007 Implement HTML writer

Status: done
Priority: high
Owner: erikvullings
Agent: codex
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
- 2026-07-15 codex: Implemented `writeHtml` standalone/preview-fragment modes and deterministic `writeHtmlZip` packaging in `@wordconvert/html-writer`. The semantic serializer covers every model block and inline node, heading TOC IDs, metadata, notes, equations, embedded passive images/fonts, print and light/dark CSS, safe links, escaping, and generated POSIX ZIP paths while omitting active asset types. Added four focused tests covering deterministic standalone output, all supported nodes, hostile input, and ZIP contents/path safety. Verified the four focused tests, full workspace tests, recursive typecheck, zero-warning lint, formatting, production build, and `git diff --check`; no known limitations within this task's scope. DOMPurify remains the required browser insertion defense for preview fragments.
