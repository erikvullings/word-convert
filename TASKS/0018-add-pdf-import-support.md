# 0018 Add PDF import support

Status: done
Priority: high
Owner: unassigned
Agent: Copilot
Area: conversion
Depends on: 0017

## Context

Extend WordConvert so books and articles in PDF format can use the existing
Markdown, HTML, and EPUB outputs without uploading document data. The initial
scope targets text-native PDFs with one or two columns. PDFs contain positioned
drawing instructions rather than Word-like semantics, so extraction, layout
analysis, page-furniture removal, and final `DocumentModel` construction must
remain separate.

Running chapter headers, page numbers, and footers should be removable. Start
with explicit top and bottom crop regions because they are predictable and
easy for users to control. Repeated-content detection may propose additional
removals, but must not silently discard low-confidence content.

## Acceptance Criteria

- The document picker accepts `.pdf` files with a safe MIME/extension check,
  while retaining existing DOCX support.
- PDF parsing uses bundled PDF.js assets in a worker and performs no
  conversion-time network requests.
- The PDF reader accepts an exact `Uint8Array`, explicit deterministic options,
  configurable resource limits, cancellation, and progress callbacks.
- Raw PDF extraction preserves pages, text spans, coordinates, font
  information, links, images, metadata, outlines, and tagged structure when
  present without directly constructing semantic output.
- Layout analysis produces stable reading order for representative
  single-column and two-column books and articles, using tagged structure when
  available and documented geometric heuristics otherwise.
- Users can exclude configurable top and bottom regions, preview the excluded
  areas, and rerun analysis without reloading the source file.
- Repeated header/footer detection normalizes variable page numbers, handles
  odd/even pages, exposes candidates with confidence, and requires user review
  when confidence is not high.
- Removed headers, footers, and page numbers do not appear in generated
  Markdown, HTML, or EPUB output and are reported through deterministic
  warnings.
- PDF metadata and inferred title/heading/body styles carry source provenance
  and remain editable through the existing metadata and style-mapping workflow.
- Scanned or text-inaccessible pages produce a clear OCR-not-supported warning;
  OCR is not required for the initial implementation.
- Password-protected, malformed, unsupported, and excessively large PDFs fail
  with private structured `ConversionError` values and release worker-owned
  resources.
- Corpus-backed tests cover tagged and untagged PDFs, one and two columns,
  odd/even running headers, page-number variants, footers, crop boundaries,
  links, images, cancellation, determinism, hostile inputs, and writer output.
- `documentation/hardening.md`, README usage, and
  `THIRD_PARTY_NOTICES.md` are updated for PDF.js, PDF-specific limits, browser
  support, performance budgets, and bundled worker/WASM assets.

## Implementation Notes

- Add a `@wordconvert/pdf-reader` package rather than introducing PDF logic in
  the DOCX reader or writers.
- Use PDF.js first: it is browser-oriented, worker-capable, Apache-2.0 licensed,
  and exposes text geometry plus tagged-PDF structure. Evaluate Rust/PDFium or
  Hayro only if measured fixtures show that PDF.js lacks required typography or
  extraction fidelity.
- Introduce a generic reader dispatch boundary in the web worker while keeping
  source-specific reader options typed. Do not weaken the existing
  `DocxReader` contract.
- Suggested pipeline:
  `PDF bytes -> raw page model -> layout analysis -> page-furniture proposals
  and user overrides -> DocumentModel -> existing writers`.
- Represent crop bounds in page-relative coordinates so mixed page sizes and
  rotations behave consistently. Apply rotation before comparing crop bounds.
- Start layout reconstruction with line grouping, whitespace-based paragraph
  grouping, and one/two-column segmentation. Preserve page boundaries in the
  raw model even if most are omitted from semantic output.
- Normalize page-number-only lines and patterns such as `Page 4 of 20` before
  repeated-content clustering. Include vertical position, alignment, font, and
  odd/even page parity in candidate identity.
- Do not auto-remove candidates from very short documents or candidates that
  also occur in the body region. Prefer retained content plus a warning over a
  false-positive deletion.
- PDF.js: <https://github.com/mozilla/pdf.js>
- PDF.js text API:
  <https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html#getTextContent>

## Agent Notes

- 2026-08-29 Copilot: Created from the PDF feasibility discussion. The
  recommended first slice is PDF.js plus explicit top/bottom crop controls for
  text-native one/two-column documents. Automatic repeated-page-furniture
  detection should remain explainable and confidence-gated. OCR and Rust/WASM
  engines are deliberate follow-ups, not initial requirements.
- 2026-08-29 Copilot: Started implementation with TDD. Planned boundaries are a
  source-neutral raw PDF model, PDF.js extraction adapter, deterministic layout
  analysis and page-furniture filtering, then typed worker and UI integration.
- 2026-08-29 Copilot: Completed browser-only PDF import with bundled PDF.js
  workers, deterministic one/two-column and tagged layout analysis, crop and
  reviewed furniture removal, metadata/styles/images/links, private limits and
  cancellation, corpus coverage, and Markdown/HTML/EPUB writer reuse. Browser
  verification confirmed cleanup reruns and Markdown preview without external
  requests; code review findings were resolved. The full 151-test suite,
  typecheck, lint, production build, static verification, formatting, and diff
  checks pass.
