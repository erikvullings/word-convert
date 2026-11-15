# 0045 Detect PDF tables and emit TableNode

Status: in-progress
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031

## Context

The document model already has tables and every writer already renders them:
`TableNode`/`TableRow`/`TableCell` with `header`, `colSpan`, `rowSpan` and `caption`
(`packages/document-model/src/index.ts`), rendered by `packages/html-writer/src/index.ts`,
`packages/epub-writer/src/index.ts` and `packages/markdown-writer/src/index.ts`. What is
missing is a producer: **no PDF path ever emits `type: 'table'`**. Every spreadsheet
print, financial statement and data appendix arrives as a stream of loose paragraphs, so
column meaning is destroyed and reflowable readers show a wall of numbers.

`REQUIREMENTS.md` lists tables as required document content and requires table fixtures
for DOCX; the PDF path has no table requirement at all, so this task also adds the
missing requirement section.

This is **not** a calibre parity item. Calibre's PDF input explicitly does not extract
tables, and 0031 originally rejected the whole row. The user asked for it on 2026-11-14,
so the design here is ours; only 0031's ordering contract and reviewability rules carry
over. Extracting vector *artwork* as separate figures stays out of scope (0031 rejection
stands).

Three signals are available at very different cost and precision:

1. **Tagged structure** — already extracted. `RawPdfPage.taggedStructure`
   (`RawPdfStructureNode` with `role` and `markedContentId`) plus `taggedRoles()` in
   `packages/pdf-reader/src/index.ts` already map marked-content ids to roles, and
   `RawPdfTextSpan.markedContentId` links text to structure. A tagged PDF that declares
   `Table`/`TR`/`TH`/`TD` gives an exact table with no guessing. Only tagged PDFs have it.
2. **Ruled lines** — not available yet. `RawPdfPage` carries no vector geometry at all,
   and `countVectorPaths()` in `packages/pdf-reader/src/pdfjs.ts` only counts
   `OPS.constructPath` in `operators.fnArray` for the dense-page decision. Ruled-table
   detection needs a new extraction surface that reads path arguments, distinguishes
   stroked rules from filled areas, and applies the page CTM and rotation.
3. **Borderless alignment** — aligned text columns on consistent row baselines with no
   rules. Highest false-positive risk (it looks like two-column body text, lists and
   verse), and it is much more reliable after 0033's line model exists.

## Acceptance Criteria

- **Slice 1 (tagged).** `analysePdf()` emits a `TableNode` for a page whose tagged
  structure tree contains a `Table` role with `TR` children: cells from `TH`/`TD`/`TC`
  in tree order, `header` from `THead` rows or `TH` cells, `caption` from a `Caption`
  child, and cell text from the spans whose `markedContentId` falls in that subtree. A
  `Table` role that cannot be resolved — no rows, no attributable text, nested `Table`
  beyond a bounded depth — produces today's paragraph output unchanged plus a
  deterministic warning code; never a partial or empty table.
- **No text loss.** For every fixture with a detected table, the concatenation of cell
  text equals the text the current paragraph path emits for the same page region, in
  reading order. This is asserted per fixture, not argued.
- **Slice 2 (ruled).** Stroked horizontal and vertical segments that form a closed grid
  (at least two of each crossing, consistent cell heights, grid inside the column) produce
  the same `TableNode`; stroke collection obeys a new per-page limit in `DEFAULT_LIMITS`
  and reports truncation instead of slowing down, and pages marked `dense`/`fallback` are
  excluded because their geometry is not trustworthy.
- **Slice 3 (borderless)** lands behind an explicit opt-in, or as a default only when
  before/after corpus evidence in Agent Notes shows no regression on
  `tests/fixtures/pdf/`.
- Detection confidence and provenance are exposed in `PdfAnalysisSummary` (per table:
  page, rows, columns, signal used, confidence) so the decision is reviewable in the
  existing SPA analysis flow, and each automatic table emits a stable warning code.
- Merged cells (`rowSpan`/`colSpan`) are represented when the source states them
  (tagged) or when the grid geometry proves them (ruled); when ambiguous, emit separate
  cells rather than guessing spans.
- Tables are never split across chapters mid-row, and 0041's size splitter must not cut
  inside a `TableNode` (`REQUIREMENTS.md`: "avoiding invalid splits inside lists, tables").
- New behaviour is additive: default output for existing fixtures is byte-identical,
  because none of them declares a table.
- Docs move together per `AGENTS.md`: a new `REQUIREMENTS.md` section for PDF table
  extraction, `documentation/cli.md` + `README.md` + `apps/cli/src/cli.ts` help if any
  option is added, and `documentation/hardening.md` budgets if the vector pass changes
  measured cost.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass.

## Implementation Notes

- Keep the 0031 ordering contract: geometry extraction stays in
  `packages/pdf-reader/src/pdfjs.ts`, deterministic detection in the analysis stage, and
  the writers keep treating `DocumentModel` as the contract — no writer may see page
  numbers or coordinates.
- Put the detector in a new `packages/pdf-reader/src/tables.ts` rather than growing
  `index.ts`; export pure functions over `RawPdfPage` plus optional stroke segments so it
  is testable without PDF.js, and keep it dependency-free and browser-safe.
- Reuse existing helpers instead of duplicating: `taggedRoles()`, `resolvePageItem()`,
  `isPageNumberText()`, furniture-candidate exclusion (a table must not be built from
  header/footer spans), `DEFAULT_LIMITS`, and `analysisCheckpoint()` inside any new
  per-page loop.
- Determinism rules: iterate structure trees and strokes in source order, sort ties by
  `(top, x)`, stable ids from the existing id helpers, no wall-clock or environment state.
- Slice 2 geometry notes for whoever picks it up: read `operators.argsArray` alongside
  `fnArray`, collect only `constructPath` with `moveTo`/`lineTo`/`rectangle` ops painted by
  stroke (`S`), honour `setLineWidth`/`setStrokeColor` (skip white/invisible), apply the
  viewport transform and `page.rotation`, and treat curves and clipping as "not a rule".
  A stroked rectangle counts as four rules.
- Fixtures go in `scripts/generate-pdf-fixtures.mjs` with entries in
  `tests/fixtures/pdf/corpus.json`: the generator already uses `pdf-lib` with
  `PDFOperator` (`pushOperators(PDFOperator.of('BDC', …))` in `taggedArticle()`) so it can
  emit both `StructElem` trees with `S: 'Table' | 'TR' | 'TH' | 'TD'` and stroked grid
  lines; add `tagged-table.pdf`, `ruled-table.pdf`, and `borderless-table.pdf`.
- Unit tests at the `analysePdf(RawPdfDocument, options)` seam using the existing
  `rawDocument()` builder in `packages/pdf-reader/src/index.test.ts` — no PDF.js mocking;
  slice 2 additionally tests the new pure stroke-collection function over an operator-list
  literal.
- Keep `TableNode.caption` semantics aligned with figure captions (0043) so one caption
  detector serves both; `Table` roles are a *second* consumer of that work, not a new one.
- Out of scope: vector artwork extraction, OCR-based table recognition, cell border
  styling preservation, and any CSS that mimics the source's table look.

## Agent Notes

- 2026-11-14 pi: Opened on user request, overturning 0031's rejection of the
  "PDF table and vector-artwork extraction" row (vector artwork stays rejected). Scoped
  as three slices in precision-first order: tagged roles (exact, zero new extraction),
  ruled strokes (needs a new PDF.js operator surface), borderless alignment (opt-in). The
  model and all three writers already support tables, so this is detection and mapping
  only — verified: `type: 'table'` appears in no `packages/pdf-reader` source file today.
- 2026-11-14 pi: **Slice 1 (tagged) implemented.** New
  `packages/pdf-reader/src/tables.ts` exports `detectTaggedTables()`,
  `layoutTaggedTables()`, `buildTaggedTable()`, `DEFAULT_TAGGED_TABLE_LIMITS` and
  `TAGGED_TABLE_CAPTION_KEY`; `linesToBlocks()` in
  `packages/pdf-reader/src/index.ts` skips lines whose spans all belong to one
  emittable table and emits the `TableNode` at the first such line, so reading
  order is preserved and a table never merges with a neighbouring paragraph.
  `PdfAnalysisSummary.tables` (`PdfDetectedTable`) and the `pdf-tables-detected` /
  `pdf-table-structure-unresolved` info warnings make the decision reviewable.
  New fixture `tests/fixtures/pdf/tagged-table.pdf` plus `taggedTable()` in
  `scripts/generate-pdf-fixtures.mjs` and a `corpus.json` entry; new EPUB test
  asserts `<table>`, `<caption>`, `<th>` and `colspan`/`rowspan` in chapter XHTML.
- 2026-11-14 pi: Design facts learned from the real fixture, worth keeping:
  **cells must be resolved from marked-content ids to spans, never from page
  lines.** PDF.js delivered `Period` and `Revenue` (same baseline, different
  cells) as a single line, so any line-based cell router silently drops the
  table. The unit tests at the `analysePdf()` seam passed while the reader test
  at the `pdfJsReader.read()` seam failed, which is why both seams stay.
  Cell lines are rebuilt by `cellLines()` in `index.ts`, mirroring `groupLines()`
  baseline and word-spacing thresholds and dropping whitespace-only spans — the
  remaining gaps re-create any separator, so no word boundary is lost.
- 2026-11-14 pi: Deliberate deviations and limits.
  - `header` comes from the `TH` role only; a plain `TD` inside `THead` stays a
    data cell. Revisit with real-world fixtures if `THead`-derived headers prove
    necessary.
  - Tagged `/Row` and `/Table` headers (`Headers`, `RowSpan`, `ColSpan`, `Scope`)
    are not read yet, so a PDF that declares merged cells arrives ragged and is
    reported unresolved rather than guessed — consistent with the "separate cells
    rather than guessing spans" rule.
  - Ragged rows (rows with differing cell counts) are unresolved, not padded.
  - Added `DEFAULT_TAGGED_TABLE_LIMITS` rather than growing `DEFAULT_LIMITS`,
    because no geometry/stroke pass exists yet; `analysisCheckpoint()` is unused
    in `tables.ts` since every traversal is bounded by `maxNodes`.
  - `taggedRoles()` is not reused: detection needs tree shape, not only roles.
    Furniture safety comes from requiring at least one *retained* span per cell,
    so a table built from cropped header/footer text cannot form.
  - No CLI option was added, so `apps/cli/src/cli.ts`, `documentation/cli.md`
    and `README.md` are unchanged, per `AGENTS.md`. `REQUIREMENTS.md` gained a
    `## PDF support` section, the first PDF requirement in that file.
- 2026-11-14 pi: Evidence. `pnpm test` 665 passed / 4 skipped (was 658 / 4),
  `pnpm typecheck` clean, `oxlint --deny-warnings` clean, `prettier --check`
  clean. Default output for every pre-existing PDF fixture is unchanged: none of
  them declares a table. `tagged-table.pdf` regenerates byte-identically
  (`sha1 7205084b95bade9a1a4dea583d4c8bf689b60d99`). Caveat for whoever runs
  `pnpm fixtures:pdf`: `encrypted.pdf` is *not* byte-stable because qpdf re-salts
  the encryption each run, so restore it to avoid an unrelated diff — a small
  determinism gap worth its own task.
- 2026-11-14 pi: Still open on this task: slice 2 (ruled grids, needs the stroke
  collection surface in `pdfjs.ts`), slice 3 (borderless, opt-in), tagged merged
  cells, and the 0041 check that the size splitter never cuts inside a
  `TableNode`.
- 2026-11-14 pi: **Merged cells and `THead` headers implemented** (slice 1
  completion). PDF.js already copies a cell's `/ColSpan` and `/RowSpan` from its
  `/A` attribute dictionary (`O: /Table`) onto the serialized structure node via
  `StructElementNode.tableAttributes`, but `readStructure()` in
  `packages/pdf-reader/src/pdfjs.ts` dropped them, so any table with a merged
  cell was rejected as ragged. Added `rowSpan`/`colSpan` to
  `RawPdfStructureNode`, forwarded them in `readStructure()`, and replaced the
  rectangularity check with `placeCells()` in `tables.ts`, which walks the
  declared cells onto a grid: a row that starts past column zero is legitimate
  when the cell above spans down, while two cells claiming one position — or a
  position no cell claims — rejects the table. `rowSpan` is clamped to the
  declared row count so the emitted HTML cannot be invalid.
- 2026-11-14 pi: Two rules worth keeping in mind when slice 2 lands.
  - A cell that declares **no** marked content is a blank cell and stays
    `{ blocks: [] }`; only a cell whose declared marks are all gone (cropped, or
    removed as furniture) makes the table unsafe. Rejecting tables for blank
    cells would drop most spreadsheet prints.
  - Cells of a `THead` row are header cells even when their role is `TD`,
    because the section states the meaning. `/Scope` and `/Headers` are parsed
    by PDF.js (`scope`, `headers`, `short`, `summary` on the node) but are not
    read here: `TableCell` has no field for them.
  Verified with four new unit cases plus `tests/fixtures/pdf/tagged-table-spans.pdf`
  (declared `/RowSpan 2` and `/ColSpan 2`), whose reader test asserts the real
  PDF.js pass-through, and an EPUB case asserting a table is never split across
  chapters (`splitChapters()` only breaks before a top-level level-2 heading, so
  a `TableNode` always moves whole — locked by a test now that 0041 will add a
  size-based splitter).
- 2026-11-14 pi: **Slice 2 ground truth, measured rather than guessed.** A
  stroked PDF was generated with `pdf-lib` and its `getOperatorList()` dumped, so
  whoever picks up ruled detection does not have to rediscover this:
  - `OPS.constructPath = 91`, and its `argsArray` entry is
    `[paintOp, [pathData], minMax]`.
  - `paintOp` is the **OPS code of the painting operator**: `stroke: 20`,
    `closeStroke: 21`, `fill: 22`, `eoFill: 23`, `clip: 29`, `eoClip: 30`. A rule
    is `20` or `21`; `22`/`23` are filled areas, not rules.
  - `pathData` is a flat numeric array of `(op, ...coordinates)` pairs in PDF user
    space: `0` = moveTo, `1` = lineTo, `12` = closePath (a `rectangle` op expands
    to moveTo + three lineTo + closePath, so a stroked rectangle is four rules).
    Any curve op encountered means "not a rule".
  - `minMax` is `[x0, y0, x1, y1]` in the same user space, useful as a cheap
    reject before per-segment work.
  - Coordinates still need the viewport transform and `page.rotation`, exactly as
    `readSpans()` does with `Util.transform(viewportTransform, item.transform)`;
    normalize to the same 0..1 page-relative space as spans.
  - Two fixture-generator traps found the hard way: `PDFOperator.of('w', [1])`
    with **raw JS numbers** silently serializes an empty content stream (use
    `document.context.obj(...)` or pdf-lib's own op helpers such as `moveTo`,
    `lineTo`, `stroke`, `rectangle`, `setLineWidth`, `setStrokingRgbColor`), and
    PDF.js must be imported from `pdfjs-dist/legacy/build/pdf.mjs` in Node —
    the modern build fails with `hashOriginal.toHex is not a function`.
- 2026-11-14 pi: Full suite note: `apps/cli` and `apps/web` tests intermittently
  fail with `Test timed out in 5000ms` only when the whole suite runs with 54
  worker files; they pass in isolation and on a rerun. Tracked as task 0046 so
  nobody mistakes it for a regression in table work.
- 2026-11-14 pi: **Slice 2 (ruled grids) implemented and on by default.** New
  seam `collectStrokeSegments(operators, viewport, maxSegments)` in
  `packages/pdf-reader/src/pdfjs.ts` returns page-relative straight strokes in
  the same 0..1 space as spans; detection is the pure
  `detectRuledTables(spans, strokes, limits)` in `tables.ts`. Both are unit
  tested over operator-list and stroke literals, plus real-PDF and corpus tests.
  Precision gates, in the order they fire:
  - a path counts only if PDF.js painted it with a stroking operator, and any
    path containing a curve, or an encoding this version does not know, is
    dropped whole rather than half-parsed;
  - white and near-white strokes are dropped (they are invisible on paper);
  - rules are merged into boundaries, then split into groups of rules that
    touch, so two tables on one page are judged separately and one broken grid
    cannot spoil a healthy neighbour;
  - a group needs at least three boundaries each way (two rows and two columns
    of cells) so separators, quotation boxes and chart axes are ordinary rules,
    not unresolved tables, and therefore do not warn;
  - every cell must be closed on all four sides within `maxEdgeGap`, so a grid
    with one short rule is refused and reported;
  - a span overlapping two cells (a merged ruled cell this slice does not read)
    refuses the grid, and a span claimed by two grids refuses both;
  - at least half the cells must hold text.
  Text outside the grid keeps its paragraph, and a line is only pulled into a
  table when every one of its spans belongs to the same grid — whitespace
  between two cells is glue and does not veto ownership.
- 2026-11-14 pi: Two bugs found by the tests rather than by review. Whitespace
  spans between cell texts share the row's baseline, so requiring every span to
  be grid-owned meant a real ruled table never emitted; and the first
  connected-components code claimed rules before checking whether they crossed,
  which swallowed the second table on a page. Both are locked by tests.
- 2026-11-14 pi: Evidence, since this became default behaviour.
  `tests/fixtures/pdf/ruled-table.pdf` (stroked 3x2 grid plus a caption outside
  the grid) yields one `ruled`/`medium` table with all six cells and the caption
  as prose; the new adversarial `tests/fixtures/pdf/ruled-non-tables.pdf`
  (separator rule, quotation box, chart axes, grid with a short middle rule)
  yields no table, keeps all ten words as prose, and reports
  `pdf-table-structure-unresolved`. A corpus guard test reads every PDF fixture
  and asserts tables appear only in the three table fixtures with exact
  provenance, so a future false positive fails the suite rather than shipping.
  `formula-layouts.pdf` and `formula-false-positives.pdf` — both full of vector
  paths — remain table-free.
- 2026-11-14 pi: Cost is bounded and recorded in `documentation/hardening.md`:
  `maxStrokeSegmentsPerPage: 4,000`, collection reports truncation, and
  truncated, dense, or rasterized pages skip ruled inference entirely.
  `REQUIREMENTS.md` gained the ruled-table requirements; the previous sentence
  forbidding ruled inference is gone. No CLI option was added, so `cli.ts`,
  `documentation/cli.md` and `README.md` are unchanged per `AGENTS.md`.
- 2026-11-14 pi: Still open — borderless aligned-column detection (slice 3,
  opt-in), merged ruled cells (needs the missing interior rule to be inferred,
  which is exactly the guessing this slice refuses), and confirmation that the
  0041 size splitter keeps a `TableNode` whole.
- 2026-11-15 pi: Slice 3 started, plus the opt-in switch the earlier slices
  lacked. `PdfAnalysisOptions` gained `pdfTables: { tagged, ruled, borderless }`
  (defaults `true`, `true`, `false`), read by both `analysePdf` and
  `pdfJsReader.read`, so each signal can be turned off independently. The CLI
  flag that exposes this is still to be done.
- 2026-11-15 pi: Ruled and borderless detection now share one emitted shape —
  `GridTable` with a `source` — so the reader has a single grid routing path
  instead of two near-copies. `detectBorderlessTables(spans, limits)` is pure
  over retained span boxes.
- 2026-11-15 pi: Borderless gates, ordered by how badly each one is needed. A
  block needs at least three consecutive rows sharing one column pattern with
  every span starting on a recurring column position; adjacent columns need a
  visible gutter, which is what separates a table from words flowing across a
  line; most cells must leave space in their column, because cells that run to
  the column edge are two-column body text; the first column may not be nothing
  but bullets or enumerators, which is a list; and one ragged row ends the
  block, so a heading or wrapped line above or below stays prose.
- 2026-11-15 pi: Two decisions worth keeping. A block refused by a precision
  gate is silent, and only a block too large to emit counts as unresolved —
  warning about every list and two-column page would be noise, and no text is
  lost either way. `minRowCoverage` was removed: within a uniform column
  pattern every cell holds text by construction, so the gate could never fire
  and was pretending to check something.
- 2026-11-15 pi: Bugs found by the tests, not by review. Cell keys were built
  from page-wide column-cluster ids while the reader asks for positional
  `row:column` keys, so a real borderless table emitted with only its first
  column filled; and `maxRowGap` defaulted to exactly the inter-row gap of the
  test grid, so whether a block held together depended on floating-point noise.
  Both are locked by tests.
- 2026-11-15 pi: Evidence. `tests/fixtures/pdf/borderless-table.pdf` (aligned
  4x3 grid, a heading above it, a bulleted list below) yields one
  `borderless`/`low` table; the heading stays prose and the list is still the
  reader's own list block. The corpus is also read with borderless switched on:
  only that fixture and `formula-false-positives.pdf` yield borderless tables,
  the latter because its monospaced `Year 2023 2024 2025` rows genuinely are a
  borderless table of figures — it is there to prove numbers do not become
  mathematics, and with the signal off by default its formula expectations are
  untouched. `two-column-article.pdf` stays prose, which is the fill gate
  working on a real page.
- 2026-11-15 pi: Cost is bounded and in `documentation/hardening.md`:
  `maxSpans: 8,000` and at most 16 tables per page, skipped on fallback,
  rasterized, dense, or span-truncated pages. `REQUIREMENTS.md` now states the
  borderless rules instead of forbidding the signal outright.
