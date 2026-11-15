# 0047 Keep structured PDF tables over learned picture regions

Status: done
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0045

## Context

`0045` made ruled grids a default-on signal, but the CLI runs with Heron layout
analysis on by default, and a learned `picture`/`table` proposal covering the
grid wins first: the region is rasterized as a figure, its text spans never
reach the reader's retained set, and ruled detection then has no cell text to
work with. The grid is then reported instead of converted.

Observed 2026-11-15 with `tests/fixtures/pdf/ruled-table.pdf` through
`runCli(..., '-f', 'html', '-o', '-')`:

- default (layout analysis on, provider `coreml`): no `<table>` in the output,
  and stderr carries
  `info [pdf-table-structure-unresolved]: One or more tables declared in the PDF
  structure could not be resolved and were retained as text.`
- same command with `--no-layout`: `<table>` with all six cells, and
  `info [pdf-tables-detected]`.

The consequence is that default-on ruled detection does nothing in the CLI's
default configuration, and `--pdf-tables` cannot help. `documentation/cli.md`
currently tells users to pass `--no-layout` for a ruled or borderless table,
which is a workaround, not the intended precedence. The `--pdf-tables` CLI tests
in `apps/cli/src/cli.test.ts` pass `--no-layout` for the same reason.

## Acceptance Criteria

- A page where ruled or tagged detection produces a complete table, and the
  layout detector proposes a `picture` or `table` region over the same area,
  converts to the structured table and does not rasterize that region.
- A page that genuinely holds a table as artwork (a scanned or image-only table,
  where no spans close a grid) keeps its current figure behaviour; text must not
  be lost in either direction.
- The precedence rule is stated in `REQUIREMENTS.md` next to the existing table
  requirements, and the `--no-layout` workaround sentence in
  `documentation/cli.md` is removed.
- A reader test injects a `PdfLayoutDetector` whose proposal covers the ruled
  fixture grid and asserts a `TableNode`, not an image block, plus a CLI test
  without `--no-layout`.
- The corpus table guard keeps its exact provenance expectations, including the
  pass with `borderless` enabled.

## Implementation Notes

`visualLayoutRegions()` in `packages/pdf-reader/src/pdfjs.ts` accepts proposals
labelled `picture` or `table` with `confidence >= 0.6`, `width >= 0.05` and
`height >= 0.03`, and rejects only those that `enclosesFlowingProse()`. A grid of
short cell texts is not flowing prose, so it passes and becomes a figure.

Two candidate fixes:

- Reject a visual region while a closed ruled grid covers it. Stroke collection
  already runs at extraction time in the same file, so the information is
  available; this keeps analysis in the reader and needs no ordering change.
  Prefer this, and gate it on a grid that actually closes, so a real picture of a
  table still rasterizes.
- Let `analysePdf()` re-claim spans claimed by a figure. This reaches further but
  fights the existing image budgets and the figure/OCR paths.

Keep the `imageBacked`, `dense`, `fallback`, and stroke-truncation exclusions
that already guard ruled and borderless inference; a page whose geometry is not
trustworthy should stay on the layout-model path.

## Agent Notes

Completed: ruled and complete tagged table regions now take precedence over
overlapping figure candidates. Regressions cover both real fixtures, a CLI run
with layout enabled, and the existing table-artwork figure path.
