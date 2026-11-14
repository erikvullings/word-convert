# 0035 Normalize PDF indents and remove fake page margins

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031

## Context

Calibre's heuristic stage has two indent-related transforms: "Replace entity indents
with CSS indents" (runs of `&nbsp;` used as a manual indent become a real CSS indent)
and "Remove fake margins" (per-paragraph left/right margins that merely reproduce the
page margins are detected and removed, with an opt-out because removal is sometimes
wrong).

Both ideas apply here, but inverted, because PDF carries geometry instead of CSS:

- A first-line indent is often the *only* paragraph-break cue in a PDF (no blank line,
  constant leading). Today only the OCR path uses it
  (`startsIndentedOcrParagraph()`); the text-native path relies on left-`x` equality in
  `canMergeLines()`, which breaks on ragged-right text and on justified text whose
  first line starts at a different `x`.
- The indent itself is currently thrown away: `ParagraphNode`
  (`packages/document-model/src/index.ts`) has no indent concept, so a book that
  distinguishes indented prose, hanging-indent glossary entries, verse, and pulled
  quotations loses that distinction in EPUB.
- Conversely, per-paragraph offsets that merely reproduce the page or column margins
  must never reach output. Today they happen to disappear (the writers emit no
  positioning), but any future indent modelling must be relative to the measured
  content edge, not to page coordinates, or every paragraph would arrive pre-indented.
- Runs of `U+00A0` / `U+3000` at line start (common in OCR'd and CJK-flavoured PDFs)
  are currently emitted as literal no-break spaces in Markdown/HTML/EPUB.

## Acceptance Criteria

- Text-native paragraph detection uses first-line indent as a boundary cue, measured
  against the column's median left edge, and works for both justified and ragged-right
  text; documents without any indent never require one.
- Extracted leading whitespace runs of `U+00A0`/`U+3000` are converted into the
  structured indent value rather than emitted as literal characters, matching calibre's
  `--fix-indents` intent.
- `ParagraphNode` gains an optional, minimal indent description (at least
  `firstLine` and `hanging`, with a small normalized magnitude) plus provenance, and
  every writer renders it deliberately: EPUB via a class in the generated stylesheet,
  HTML via the same class, Markdown with a documented deterministic fallback
  (no invented syntax).
- Indent values are computed relative to the detected column content edge; the uniform
  page/column margin is provably removed rather than encoded, reported through one
  deterministic `info` warning with the number of normalized paragraphs.
- Large, repeated, uniform left indents that also have a short trailing line or a
  citation-like context are proposed as `blockquote` rather than indented paragraphs —
  gated on confidence and covered by fixtures; plain indented prose must not become a
  blockquote.
- Fixture coverage: indent-only paragraph breaks, hanging-indent glossary, verse,
  block quote candidate, `nbsp`-indent page, and a no-indent document where the feature
  must be a no-op.
- Document-model, EPUB, HTML, and Markdown writer test suites all cover the new field,
  and `documentation/core-contracts.md` documents it.

## Implementation Notes

- Model change first, and keep it small: extend `ParagraphNode` in
  `packages/document-model/src/index.ts`, bump/validate the model schema per existing
  convention, then update `packages/html-writer`, `packages/markdown-writer`,
  `packages/epub-writer`, and the SPA content editor so the field round-trips.
- Column-relative measurement belongs next to the existing column/reading-order code in
  `packages/pdf-reader/src/index.ts` (`readingOrder()`, `groupLines()`,
  `linesToBlocks()`); compute a per-column content edge as the weighted mode of line
  `x` and a per-document median indent, and reuse both for blockquote proposals.
- Do not reuse raw `PdfLine.x` as an output value anywhere; store the normalized
  relative indent only.
- Keep `ImageBlockNode.alignment` semantics untouched; do not overload it for text.
- Writers must not need page numbers or coordinates: if a writer is handed geometry,
  the boundary is wrong.
- Verified against calibre v9.18.0. `HeuristicProcessor.fix_nbsp_indents()` converts a
  leading run of **2 or more** U+00A0 at the start of a `p`/`div` (optionally through
  nested `<span>` tags) into `style="text-indent:3%"`, and `cleanup_markup()` then
  collapses every remaining U+00A0 to a space: calibre *converts* fake indents into real
  ones rather than deleting them, which is the intent our first-line-indent cue should
  copy. `RemoveFakeMargins` in `ebooks/oeb/transforms/page_margin.py` runs **after CSS
  flattening**, groups elements per level, resolves declared margins through the
  flattened stylesheet, removes a left/right margin only when the same value appears on
  almost every element at that level, and abandons the entire level when a negative text
  indent is detected (`NegativeTextIndent`). That level-level bail-out is the model for
  our "keep and report" rule for hanging indents.
- Update `REQUIREMENTS.md` only for the new preserved detail, and `documentation/
  hardening.md` budgets if measured cost changes.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. This is the task where calibre's "fake margins"
  idea needs the most translation: calibre *removes* margins from an author stylesheet,
  here the equivalent duty is to make sure geometry-derived indents are normalized
  against the column edge before they enter the model. Consider landing the blockquote
  proposal as a separate follow-up review step if the confidence gate proves hard to
  tune; the indent field itself is the valuable core.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
