# 0020 Detect and reconstruct PDF formulas

Status: open
Priority: high
Subsystem: conversion
Depends on: 0019

## Context

Build the deterministic reader-domain foundation for formula extraction from
text-native PDFs. Candidate generation must combine Heron `formula` proposals
with text, font, geometry, and useful tagged-structure evidence. It must detect
inline runs as well as display regions without treating every italic variable,
centered heading, code fragment, or numeric table cell as mathematics.

This phase deliberately uses a fake injected recognizer for complex candidates.
It establishes stable candidate IDs and final `DocumentModel` semantics before
introducing browser model assets or review UI.

## Acceptance Criteria

- `RawPdfTextSpan` preserves a stable normalized baseline and, where cleanly
  available from PDF.js, ascent and descent without retaining PDF.js objects.
- A dedicated `packages/pdf-reader/src/formula/` domain module exposes typed math
  features, candidates, confidence bands, source evidence, and named scoring
  constants.
- Feature extraction covers math-font hints with subset-prefix normalization,
  operators, Greek and structural symbols, token shape, superscript/subscript
  geometry, baseline/font-size variance, isolation, centering, multiline
  structure, and equation numbers.
- Heron proposals above a named conservative threshold and geometry proposals
  are fused deterministically by overlap/containment while nearby equations stay
  distinct and final bounds remain page-bounded.
- Existing display-equation heuristics are folded into the unified candidate
  pipeline; formula regions do not enter picture/table grouping.
- Mixed prose lines can produce text/equation/text inline nodes. Simple,
  high-confidence expressions are reconstructed as TeX without recognition;
  equation numbers remain separate text where practical.
- Deterministic reconstruction supports identifiers, numbers, Greek letters,
  common operators/relations/arrows, Unicode and geometry-based scripts, simple
  divisions, parentheses, Unicode minus, and multiplication symbols. Complex
  fractions, roots, matrices, integrals, and multiline structures are delegated.
- `DocumentModel.Equation` gains backwards-coherent display, recognition,
  PDF-location, confidence, and review provenance. Existing writers remain
  source-agnostic and continue to render generic inline/block equations.
- `PdfFormulaRecognizer`, formula image/recognition values, formula decisions,
  candidate summaries, and configurable formula limits have browser-independent
  reader contracts. Raw/sample analysis does not require recognition.
- Resource caps cover candidates per page/total, crop pixels per item/total, and
  recognition tokens; limit failures retain source content and emit targeted
  warnings rather than failing conversion.
- Unit tests cover prose and false positives, inline and display math, feature
  evidence/scoring, fusion, deterministic IDs, page-bounded padding, TeX
  reconstruction, fake recognizer invocation, cancellation/failure, model JSON
  safety, decisions, and writer regressions.

## Implementation Notes

- Start with tests around `packages/pdf-reader/src/index.test.ts` and focused
  formula-module tests. Keep `packages/pdf-reader/src/pdfjs.ts` orchestration
  thin and ONNX-free.
- Proposed warning codes: `pdf-formula-recognition-unavailable`,
  `pdf-formula-recognition-failed`, `pdf-formula-low-confidence`,
  `pdf-formula-invalid-tex`, and `pdf-formula-limit-exceeded`.
- Candidate IDs must depend on page and stable reading order, never recognized
  TeX. Remove/replace source spans only after creating a final equation node.
- Automatically accept only strongly evidenced deterministic reconstructions.
  Recognition output remains reviewable even when usable for export.
- Use TDD at feature extraction, fusion, reconstruction, and recognizer seams.

## Agent Notes

- 2026-09-02 GitHub Copilot: Created from phase 1 of the PDF formula
  specification. First step is to inspect current display-equation extraction in
  `packages/pdf-reader/src/pdfjs.ts`, write focused failing tests for the formula
  domain, then make the smallest candidate-pipeline integration.