# 0026 Preserve optional DOCX ToC links

Status: done
Priority: medium
Subsystem: conversion
Depends on: 0005, 0008, 0009

## Context

DOCX tables of contents can contain explicit internal `w:hyperlink` anchors
whose targets are `w:bookmarkStart` elements on document headings. The reader
currently flattens these internal links to plain text, even when every source
anchor has a matching bookmark. Preserve authoritative bookmark links without
guessing from heading text, but allow users to remove them because stale Word
fields or bookmarks may be unreliable in other documents.

## Acceptance Criteria

- DOCX bookmark targets are represented by stable heading IDs and matching
  internal links are preserved in the semantic model.
- Markdown emits working explicit anchors and ToC links by default; a persisted
  Markdown output option removes internal document links and anchors while
  retaining their visible text.
- HTML and EPUB output preserve valid internal links and target IDs without
  introducing unsafe URLs or duplicate IDs.
- Markdown preview does not visibly render explicit anchor elements. Verify the
  current renderer behavior first; add filtering only if the renderer exposes
  anchor markup as visible content.
- Missing bookmark targets degrade to plain text with a deterministic warning.
- Reader, writer, worker, state, and preview tests cover enabled and disabled
  behavior.

## Implementation Notes

- Use explicit OOXML `w:hyperlink/@w:anchor` and `w:bookmarkStart/@w:name` data;
  do not infer destinations from ToC text or generated heading slugs.
- Keep page-number `PAGEREF` field results omitted from flowing outputs.
- The option belongs to Markdown output settings and defaults to preserving
  links.

## Agent Notes

- 2026-09-04 GitHub Copilot: Source document contains 46 unique ToC anchors and
  all 46 have matching `_Toc...` bookmarks. Current reader drops internal
  anchors in `parseInlines`; Markdown already accepts safe fragment links.
- 2026-09-04 GitHub Copilot: Implemented bookmark alias canonicalization and
  structured-content traversal in `packages/docx-reader/src/index.ts`, optional
  Markdown fragment links and heading anchors in
  `packages/markdown-writer/src/index.ts`, and the persisted web/worker option.
  The existing Slimdown and DOMPurify pipeline retains empty anchors without
  visible preview text, so no preview filter was added. Real-document validation
  preserved 45 links to semantic headings; the remaining bookmark targets table
  placeholder text and degrades to plain text with one warning. Full validation:
  329 tests passed, 2 skipped; type-check and lint passed.
