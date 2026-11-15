# 0033 Add median-length driven PDF line unwrapping with a tunable factor

Status: done
Priority: high
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031

## Context

Calibre exposes **two separate** unwrap controls, and the distinction matters:

- `--unwrap-factor` (PDF input, default **0.45**) is used by the calibre PDF engine in
  `ebooks/pdf/reflow.py::Page.coalesce_paras` → `can_merge()`: two lines merge only when
  the first line is wider than `page width × unwrap_factor` (so a short line ends the
  paragraph), alongside same-column, line-space and quote guards.
- `--html-unwrap-factor` (heuristics, default **0.4**) feeds
  `DocAnalysis.line_length(factor)` in `ebooks/conversion/utils.py`, a percentile of
  measured line lengths, and is only reached when the document actually shows hard breaks
  (`DocAnalysis.line_histogram(0.50)`) or the user lowered the factor below 0.4.

WordConvert's non-OCR merging (`canMergeLines()` in
`packages/pdf-reader/src/index.ts`) only compares left `x` (±0.04) and vertical gap
(≤ 0.8 × line height). Consequences observed in the code, not yet measured on fixtures:

- line length and terminal punctuation are never consulted, so stacked short lines
  (verse, drama, step lists, glossaries, tabular author lines) collapse into one
  paragraph whenever they share a left edge;
- a paragraph whose leading is slightly larger than 0.8 × line height stops merging and
  becomes a stack of one-line paragraphs, with no user recourse;
- the OCR path already has the richer rules (`canMergeOcrLines()`,
  `isOcrVerseLineContinuation()`, `startsIndentedOcrParagraph()`,
  `isSoftOcrHyphenContinuation()`) but they are unreachable for text-native pages.

## Acceptance Criteria

- Paragraph-boundary decisions for text-native pages combine three deterministic
  signals instead of geometry alone: relative line length against the document
  (per column) median line length, terminal punctuation of the previous line, and
  leading/indent of the next line.
- A typed `unwrapFactor` option (0..1, documented default, validated) controls the
  short-line threshold; `0` disables length-based unwrapping (pure current geometry
  behaviour) and `1` forbids merging on length alone, following calibre's
  `firstLineWidth > pageWidth × factor` formulation.
- A separate hard-break pre-check avoids touching documents that have no hard line
  breaks: unwrap only when the line-end histogram shows a dominant break region
  (calibre uses 50%) or the user explicitly lowered the factor, so a normally typeset
  book is never re-flowed by accident.
- Short stacked lines that are *not* continuations (verse, list-like runs, single-line
  headings, lines ending sentence-final punctuation followed by an uppercase or
  indented line) stay separate paragraphs; add fixtures for at least verse and a
  glossary/step list.
- Over- and under-merging are observable: a deterministic `info` warning reports how
  many lines were joined and how many paragraph boundaries were kept, per document.
- Existing corpus output is byte-identical at the default factor; any intentional
  default change requires before/after fixture evidence in Agent Notes.
- The OCR path and the non-OCR path share one continuation rule set, so a document
  mixing text-native and image-backed pages behaves consistently.
- `--unwrap-factor` appears in CLI help, `documentation/cli.md`, and `README.md`
  (coordinate with 0032 if it lands first).

## Implementation Notes

- Work in `packages/pdf-reader/src/index.ts`: `groupLines()`, `readingOrder()`,
  `linesToBlocks()`, `canMergeLines()`, `canMergeAcrossPage()`. Keep
  `PdfLine` unchanged; do not move merging decisions into the writers.
- Compute the median line length like `weightedMedianFontSize()` does for sizes
  (`packages/pdf-reader/src/pdfjs.ts`), over body-mapped lines only, per column
  segment and page, falling back to the document median when a column has too few
  lines; exclude furniture candidates and heading-mapped lines.
- Continue to require same page, comparable font style, and column membership before
  any length rule is consulted; length rules may only *refuse* a merge that geometry
  allows, except for the documented hyphen/edge-overflow continuation cases.
- Preserve cross-page continuation behaviour (`canMergeAcrossPage()`,
  `canStartPageContinuation()`); a page break must not become a paragraph break just
  because a line ends short (common for justified books).
- Keep it bounded and checkpointed: reuse `analysisCheckpoint()` inside the new
  per-page loops and keep everything O(lines).
- Verified guard set from calibre's `can_merge()` worth reproducing, each with a fixture:
  same column; the following line contains no link (calibre refuses to merge link text,
  which is what protects printed contents lists from becoming one paragraph); no
  `float:right`-style multi-line artefact; the vertical gap stays within a line-space
  tolerance derived from document line-spacing statistics rather than a fixed multiple of
  glyph height; left edge may "wander" by a small constant (`SAME_INDENT`) because
  justified PDFs shift by a pixel or two per line; and adjacent quotes at a join point
  (`adjacent_quotes()`) suppress the merge because `"…` / `…"` pairs usually signal real
  paragraph boundaries.
- Tests: extend `packages/pdf-reader/src/index.test.ts` and add generator functions in
  `scripts/generate-pdf-fixtures.mjs` (verse page, loose-leading page, glossary page)
  plus `corpus.json` `covers` entries; assert both directions (no over-merge, no
  under-merge) rather than snapshot-only.
- Useful reference for expected behaviour: `ebook-convert tests/fixtures/pdf/
  one-column-book.pdf /tmp/calibre-unwrap.epub --unwrap-factor 0.45` as an offline
  comparison only (see the GPLv3 rule in 0031). Compare against both engines
  (`--pdf-engine calibre` and `pdftohtml`) before concluding which behaviour to mirror.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Chosen as the highest-leverage calibre idea: it is
  the single knob calibre users are told to reach for first with PDF input, and today
  the repository has no equivalent. Note the asymmetry to exploit: the OCR merge path
  already implements the good rules, so this is largely lifting them to the shared
  path and adding the median-length signal.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
- 2026-11-13 pi: Implemented bounded line profiles, short-line paragraph boundaries, configurable unwrap factor, and review-only column-order diagnostics in `packages/pdf-reader/src/index.ts`; added generated verse, glossary, and loose-leading fixtures and CLI controls/documentation. Calibre 9.18.0's `calibre` and `pdftohtml` engines disagree on verse/glossary grouping, so WordConvert keeps short stacked entries distinct and uses an explicitly lowered factor for loose-leading joins. Compared default CLI output with factor `0` across all 11 pre-existing valid PDF fixtures; after keeping expanded gap tolerance opt-in, all outputs are identical. Focused reader and CLI regression tests pass.
