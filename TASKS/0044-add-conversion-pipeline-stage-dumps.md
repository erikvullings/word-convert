# 0044 Add conversion pipeline stage dumps and verbosity levels

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: cli
Depends on: 0031

## Context

Calibre's debugging story is one flag: `--debug-pipeline <folder>` writes the document as
each stage sees it into `input/`, `parsed/`, `structure/`, and `processed/`, and the
manual tells users to edit files in `input/` and re-feed the ZIP. Combined with `--verbose`
levels, this is how conversion bugs get diagnosed at all — and it is how 0032–0043 will
get diagnosed here.

WordConvert currently exposes progress messages and a JSON-ish analysis summary through
the SPA, and nothing at all from the CLI (`apps/cli/src/pdf.ts` discards
`PdfAnalysisResult.analysis` apart from diagnostics it prints). When a book comes out
wrong, there is no way to tell whether extraction, furniture removal, paragraph merging,
heading analysis, or the writer is at fault, so every report needs a reproducible
investigation from scratch.

## Acceptance Criteria

- `--debug-pipeline <dir>` writes one artifact per stage for a real conversion, with the
  same objects the conversion used (no second pass):
  1. `1-raw.json` — `RawPdfDocument` (pages, spans, geometry, fonts, links, tagged
     structure) with image bytes replaced by size + SHA-256 references;
  2. `2-analysis.json` — `PdfAnalysisSummary` (crop, furniture candidates, scanned/image-
     backed/dense/fallback pages, formula candidates and image regions);
  3. `3-model.json` — the final `DocumentModel` (blocks, styles, metadata, equations,
     warnings) with assets replaced by references;
  4. `4-output/` — the pre-packaged writer artifacts (XHTML files, `styles.css`,
     `package.opf`, `nav.xhtml`) exactly as the EPUB/HTML writer produced them, plus a
     readable/pretty variant where the writer supports it;
  5. `0-request.json` — the effective, sanitized option set actually used.
- Stage dumps never change conversion behaviour or output bytes: converting with and
  without the flag produces identical output (asserted by test), and dumping is
  best-effort with a warning rather than a fatal error.
- Dumps are deterministic: no timestamps, no absolute paths, no hostnames, stable key
  order, and no source filename leakage beyond the sanitized basename already used in
  output; asset bytes are omitted unless a separate explicit flag copies them.
- Privacy boundaries are explicit and tested: the directory must be created by the tool,
  may not be the input file's directory, an ancestor of it, an existing non-empty
  directory, or outside the current working directory without `--force`; help text and
  `documentation/cli.md` state that dumps contain document text.
- `--verbose` (repeatable, `0..2`) adds stage timings, per-stage object counts, applied
  option summary, and provider/model selection to stderr without changing stdout; default
  output stays as it is today. Setting `--debug-pipeline` implies at least the stage-timing
  level even when `--verbose` is absent (calibre forces its verbosity to the maximum when
  `--debug-pipeline` is given), so stage artifacts are never written without the messages
  that explain them.
- The same stage data is available programmatically (a typed `onStage`/`debugSink` hook on
  the reader/writer options or a shared debug interface) so the SPA can show it later
  without duplicating serialization.
- Fixture tests cover PDF, DOCX, and EPUB-shrink paths; `--help`, `documentation/cli.md`,
  and `README.md` document the flag, its privacy notes, and the stage list.

## Implementation Notes

- Put serialization in one module (for example `apps/cli/src/pipeline-debug.ts`) with an
  explicit allowlist per stage; never `JSON.stringify` an object graph blindly — asset
  `Uint8Array`s, `ArrayBuffer`s, and injected adapters must be filtered out, not
  base64-inlined.
- Reuse `analysisCheckpoint()`-style yields between stages and cap serialized size
  (truncate long text arrays with a recorded `truncated: true`) so a 2000-page dump cannot
  exhaust memory.
- `3-model.json` is also the natural fixture format for the other subtasks in this epic:
  prefer adding golden-model assertions in reader tests once it exists.
- For the EPUB path, capture writer output before ZIP assembly rather than unpacking the
  result, keeping fixed ZIP timestamps and `dcterms:modified` handling untouched.
- Consider making `0-request.json` the same shape as the existing options validation
  output so option-parsing regressions (0032, 0039, 0040) become visible in review.
- Add the flag and its filesystem boundaries to the `documentation/hardening.md` CLI
  boundaries section with the test that enforces them.
- Verified against calibre v9.18.0: `ebooks/conversion/plumber.py` creates
  `input/`, `parsed/`, `structure/`, `processed/` under `--debug-pipeline`, writes a
  `README.txt` describing the stages, and dumps serialized HTML at each boundary. It also
  raises `--verbose` to at least 4 whenever `--debug-pipeline` is set (plumber.py), which
  is the behaviour our `--debug-pipeline` should copy — asking for stage files implies
  wanting the diagnostics that explain them. The
  heuristic stage adds a fifth, `preprocess/`, writing numbered `0001.html`, `0002.html`
  dumps after selected internal steps (`HeuristicProcessor.dump()` in
  `ebooks/conversion/utils.py`) — the same idea as our numbered sub-steps and a good
  precedent for dumping *inside* a stage rather than only between stages. The
  typed-JSON stage files in this task are otherwise a deliberate improvement — HTML dumps
  cannot show confidence values, furniture decisions, or mapping provenance, which is the
  whole reason this task exists before the other heuristic subtasks land.

## Agent Notes

- 2026-11-13 pi: Split out of 0031 and the recommended first slice, because every other
  heuristic task in this epic needs before/after evidence at stage level. Keep the dump
  format stable and versioned (`"schema": 1`) — it will become the debugging lingua franca
  for PDF issues and probably the fixture format for reader tests.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
