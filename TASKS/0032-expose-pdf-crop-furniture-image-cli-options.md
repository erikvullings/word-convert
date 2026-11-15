# 0032 Expose PDF crop furniture and image options in the CLI

Status: done
Priority: high
Owner: unassigned
Agent: pi
Subsystem: cli
Depends on: 0031

## Context

Calibre's PDF input panel exposes the only extraction knobs users actually reach for:
`--pdf-header-skip` and `--pdf-footer-skip` (negative = auto-detect, zero = disable,
positive = remove everything above/below that pixel offset), `--pdf-header-regex` /
`--pdf-footer-regex`, and `--no-images`.

WordConvert has the equivalent reader capability — `PdfAnalysisOptions.crop`,
`removeDetectedFurniture`, `removedCandidateIds`, `retainedCandidateIds` in
`packages/pdf-reader/src/index.ts` and `PdfReaderOptions.limits` — but it is only
reachable from the SPA analysis UI. `apps/cli/src/pdf.ts` builds `CliPdfOptions` and
never sets any of them, so headless and batch conversions cannot drop a running
footer, cannot disable an over-eager automatic removal, and always extract images.

## Acceptance Criteria

- `wordconvert book.pdf` accepts analysis options that map onto the existing typed
  reader options, with no reader-side behaviour change when they are omitted:
  - `--crop-top <0..1>` / `--crop-bottom <0..1>` (fraction of the rotated page,
    validated by `validateCrop()`), with a clear error outside the range;
  - `--no-remove-furniture` disables automatic repeated header/footer/page-number
    removal and emits the resulting warning instead of removing content;
  - `--remove-furniture <id>` / `--keep-furniture <id>` (repeatable) apply saved
    review decisions by candidate id for deterministic reruns;
  - `--no-images` skips image extraction and warns once with the count of omitted
    figures.
- `--list-furniture` (or equivalent) prints detected candidates with id, kind, page
  parity, confidence, page coverage, and normalized text, then exits, so users can find
  ids for `--remove-furniture`/`--keep-furniture` without opening the browser.
- Combination rules are explicit and tested: `--no-images` with a layout model,
  `--no-remove-furniture` with `--remove-furniture`, `--crop-*` with `--no-layout`,
  and `--no-images` with `--split-chapters` (EPUB input path is unaffected).
- Deterministic output: identical bytes for identical inputs and flags, including the
  furniture candidate ids, and no change to defaults for `tests/fixtures/pdf/`.
- `--help`, `documentation/cli.md`, and `README.md` document every new flag together,
  per `AGENTS.md`.

## Implementation Notes

- Options parsing and validation: `apps/cli/src/cli.ts` (keep the existing strict
  unknown-flag behaviour); PDF wiring: `apps/cli/src/pdf.ts`; reader contract:
  `packages/pdf-reader/src/index.ts` (`PdfReaderOptions`).
- `--no-images` should be enforced as an extraction-side switch (skip `readImages()` /
  figure rasterization in `pdfjs.ts`, or filter the resulting `RawPdfPage.images`) so
  rasterization cost is actually saved; state clearly in help that it also disables
  figure and rendered-equation images.
- Candidate ids come from `furnitureId(key)` and must stay stable across runs; add a
  reader test asserting id stability for the `one-column-book.pdf` corpus fixture.
- Verified against calibre v9.18.0 (`ebooks/pdf/reflow.py`): `--pdf-header-skip` /
  `--pdf-footer-skip` are tri-state pixel values (`< 0` auto-detect, `0` off, `> 0`
  explicit cut line). Auto-detection (`find_header_footer`) scans at most
  `PAGE_SCAN_COUNT = 20` pages and `LINE_SCAN_COUNT = 2` lines from each end, never past
  half the page height, counts exact text matches plus two pattern families —
  `pagenum_text` (`n xxx n`, `n …`, bare Arabic/Roman numerals) and `fixed_text`
  (constant text with a trailing number) — requires **more than half** the scanned pages
  to match, then computes a single y cut line and `remove_header_footer` deletes every
  line above/below it on **all** pages. Documented deviations for us: fractional
  per-page crop instead of absolute pixels (mixed page sizes and rotation), per-candidate
  removal with confidence and odd/even parity instead of one unconditional band, and no
  removal on documents too short to give the majority test meaning. Calibre's 20-page /
  2-line sampling window is a useful calibration starting point for our
  `samplePageCount` and furniture band defaults.
- Report applied decisions in the existing analysis summary output (`PdfAnalysisSummary
  .candidates`) so `--list-furniture` and normal conversion share one code path.
- Fixtures: extend `scripts/generate-pdf-fixtures.mjs` with a repeated-odd/even-footer
  document if the corpus does not already exercise parity, and cover the flags in
  `apps/cli/src/cli.test.ts` plus a reader-level test.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Deliberately reader-option-only: no new heuristics
  here, just reachability of what the reader already does. User-regex furniture removal
  is 0039, and the unwrap knob is 0033, to keep this change reviewable as pure CLI
  plumbing.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
