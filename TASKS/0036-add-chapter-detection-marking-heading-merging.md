# 0036 Add configurable chapter detection marking and heading-run merging

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: conversion
Depends on: 0031, 0033

## Context

Calibre's structure-detection stage is what turns flat XHTML into a book:

- "Detect and markup unformatted chapter headings and sub headings" promotes
  body-styled lines to `h2`/`h3` when they look like chapter openers;
- `--chapter` selects chapter titles (default: `h1`/`h2` matching
  `chapter|book|section|part` or `class="chapter"`), and `--chapter-mark` decides
  whether a detected chapter gets a page break, a rule, both, or nothing;
- `--page-breaks-before` inserts breaks at any additional matched elements;
- "Renumber sequences of `<h1>` or `<h2>` tags" merges consecutive heading tags that
  publishers used for one split title, specifically so chapter splitting does not cut a
  title in half.

WordConvert has heading *style* analysis (`analyseStyles()`, `semanticHeadingLevel()`,
`isLikelyHeadingLine()`, `isLikelyOcrHeadingLine()` in
`packages/pdf-reader/src/index.ts`) and a fixed chaptering rule in the writer
(`splitChapters()` splits at one hard-coded heading level), but no chapter concept:

- a PDF whose publisher set chapter openers in the body font never gets chapters, so
  the EPUB is one file with a two-item nav;
- consecutive headings for a single title (`THE` / `LONG WAIT`, or a title split across
  two styles) split the chapter mid-title;
- users cannot say "chapters start at `Part …`" or "chapters start at heading level 2";
- there is no chapter marking choice for the standalone HTML output, and the writer's
  split level is not configurable.

## Acceptance Criteria

- A typed, serializable `chapterDetection` option (reusable like `styleMappings`, so
  analysis reruns are deterministic) with: `off | automatic | custom`, allowed heading
  levels, a curated keyword set (default matching calibre's
  chapter/book/section/prologue/epilogue/part), optional `styleIds`, and optional
  bounded patterns; unknown or malformed values are rejected with a structured error.
- Unformatted chapter openers (body font, own line, short, surrounded by vertical space
  or page top/bottom, appearing repeatedly at a regular interval) are promoted to
  heading blocks with provenance and a confidence level; low-confidence promotions are
  proposals surfaced to the existing SPA review/style-mapping flow rather than applied
  silently.
- Consecutive heading blocks that form one title are merged into a single heading
  (preserving `numbering`, inline styling, and stable ids) so chapter splitting cannot
  separate them; a genuine heading sequence such as `h1` title + `h2` subtitle stays
  two levels when their styles differ meaningfully.
- Chapter marking is selectable (`pagebreak | rule | none | both`) and applied
  consistently: EPUB by chapter file boundaries, HTML/Markdown by their documented
  equivalents; the choice is an explicit writer option, never a side effect.
- The EPUB chapter split level is configurable within the documented range, defaults
  unchanged, and never splits inside lists, tables, quotations, or equation blocks
  (existing `REQUIREMENTS.md` rule).
- Deterministic warnings report promoted candidates, merged heading runs, and the
  resulting chapter count; fixtures cover keyword chapters, unstyled openers, split
  titles, `Part`-level nesting, and a document with no chapters.
- The `--chapter-detection`, `--chapter-mark`, and split-level flags land in CLI help,
  `documentation/cli.md`, and `README.md` together.

## Implementation Notes

- Keep promotion in the reader's analysis stage (`packages/pdf-reader/src/index.ts`),
  not in the writers: writers must keep treating the model as the contract. Structure
  detection that is format-neutral may live in a shared module so the DOCX/HTML/Markdown
  paths can use it later.
- Do not conflict with `REQUIREMENTS.md` "Style analysis and heading inference":
  explicit styles and user `styleMappings` always outrank detection; detection only
  fills unassigned body lines. Document the precedence table if it changes.
- Reject arbitrary XPath (see 0031 non-goals). If text patterns are exposed, bound the
  pattern work like 0039 does (input length cap, no nested quantifiers, wall-clock
  budget) and prefer the curated keyword set as the default path.
- Chapter marking must not fabricate a `pageBreak` block inside a list item or table
  cell; validate block position before inserting.
- `splitChapters()` in `packages/epub-writer/src/index.ts` is the single split point —
  note the current code splits at level 2 while `REQUIREMENTS.md` ("EPUB Output")
  describes Heading 1 splitting; reconcile the documentation and the code in this task
  and keep "avoid invalid splits" intact.
- Serialisable option → validate it in the SPA before persisting, following the
  existing `wordconvert.style-preset` versioned-validation pattern; never persist source
  buffers.
- Fixtures: add generator functions for unstyled chapter openers and split titles in
  `scripts/generate-pdf-fixtures.mjs`, and end-to-end tests asserting the nav and spine
  chapter count for each fixture.
- Verified against calibre v9.18.0, useful as calibration for our confidence gate
  (`HeuristicProcessor.markup_chapters()` in `ebooks/conversion/utils.py`):
  - the whole heuristic stage is skipped for documents under **50 words**;
  - the required number of chapters is derived from length, `ceil(wordcount / 7000)`
    (raised to `ceil(wordcount / 15000)` above 200 000 words), with a hard cap of 150 so
    OCR noise and page numbers cannot be mistaken for a table of contents; detection
    bails when the found heading count is below that minimum;
  - patterns are tried in likelihood order and it **stops at the first pattern that
    succeeds**, deliberately trading recall for few false positives — the same posture we
    want for promotion;
  - `no_markup(html, 0.1)` measures what fraction of line endings already carry
    `</p>`/`</div>`; when **fewer than 10%** do, the document is considered to have no
    usable paragraph structure at all and paragraph markup is inserted first
    (`markup_pre()`) before any other heuristic runs. The equivalent precondition for us
    is to require a minimum paragraph-segmentation confidence from 0033 before chapter
    detection is allowed to promote anything, and to report "segmentation looks too flat
    to trust" instead of promoting when it fails.
- Correction from the source, which changes this task's design decision: the help text
  "renumber sequences of `<h1>` or `<h2>` tags as a single heading" is implemented in
  `HeuristicProcessor.process()` as a **demotion**, not a merge — when an `h1`/`h2` is
  immediately followed by another `h1`/`h2` (blank lines and non-heading tags allowed in
  between), the second is rewritten to `h3` "to prevent splitting between chapter
  headings and titles, images, etc". For `THE` / `LONG WAIT` that keeps two blocks but
  stops the second from starting a new chapter. Since our model has real heading levels
  and block identity, spell out both options here and pick deliberately: demote (calibre
  parity, two blocks, one chapter) or merge into one `HeadingBlockNode` (better output,
  needs the multi-line title rules from this task). Record the decision and the fixture
  that proves it.

## Agent Notes

- 2026-11-13 pi: Split out of 0031 and sequenced after 0033 because heading candidates
  depend on final paragraph boundaries. Two things to watch: (1) the level-2 split in
  `splitChapters()` contradicting the documented Heading-1 rule, and (2) the temptation
  to accept XPath for parity with calibre — declined in 0031, and the typed predicate
  must stay serializable so the SPA can persist it as a preset.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
