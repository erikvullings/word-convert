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
