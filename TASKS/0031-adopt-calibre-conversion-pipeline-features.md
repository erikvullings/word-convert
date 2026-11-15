# 0031 Adopt calibre-inspired PDF to EPUB conversion stages

Status: done
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: conversion
Depends on: none

## Context

Calibre's `ebook-convert` (surveyed locally: calibre 9.18.0 at
`/opt/homebrew/bin/ebook-convert`, plus
<https://manual.calibre-ebook.com/conversion.html>) runs conversion as an explicit
pipeline: *input plugin → intermediate XHTML → a long chain of optional transforms →
output plugin*, with each stage dumpable for debugging.

WordConvert already has the same shape (`PDF bytes → raw page model → deterministic
analysis → DocumentModel → writers`) and is *stronger* than calibre's PDF input in
several areas: Heron layout analysis, figure rasterization, dense-vector page
fallbacks, tagged-PDF reading order, and local formula recognition. Calibre's own
manual states that its PDF input does not support complex/multi-column or image-heavy
documents and does not extract vector images or tables. (The manual also claims links
and TOCs are unsupported; the v9.18.0 source is ahead of the manual here —
`ebooks/pdf/reflow.py::PDFDocument.generate_toc()` builds an NCX from the PDF outline
when it has more than two entries. See "Verified against source" below.)

WordConvert is *weaker* in the transform stage: between "lines are grouped" and
"blocks are emitted" there is almost nothing tunable or reviewable, and the CLI
exposes no PDF knobs at all (`apps/cli/src/cli.ts` has no crop, furniture, unwrap, or
image options). This epic adopts the calibre ideas that close those gaps and rejects
the ones that only make sense for calibre's CSS-normalizing HTML pipeline.

Surveyed calibre options and their status here:

| calibre feature | WordConvert status today | Subtask |
| --- | --- | --- |
| `--pdf-header-skip`, `--pdf-footer-skip`, `--no-images`, `--pdf-engine` | Reader has fractional `crop` + confidence-gated furniture detection, but only reachable from the SPA; no image toggle; `--no-layout`/`--layout-model` already cover engine choice | 0032 |
| `--unwrap-factor` (PDF engine, default 0.45, compared against **page width**) and `--html-unwrap-factor` (heuristics, default 0.4, a line-length percentile) | `canMergeLines()` in `packages/pdf-reader/src/index.ts` uses fixed alignment/width heuristics; neither signal exists and neither is configurable | 0033 |
| Document-wide de-hyphenation (two passes, document as dictionary) | Only soft-hyphen continuation at line ends in the OCR path (`isSoftOcrHyphenContinuation`) | 0034 |
| `--fix-indents`, `--disable-remove-fake-margins` | No first-line-indent paragraph cue; per-paragraph left/right offsets from page geometry are baked into line positions | 0035 |
| `--chapter`, `--chapter-mark`, `--page-breaks-before`, `--renumber-headings`, unformatted-heading markup | Headings come from style analysis only; `splitChapters()` in `packages/epub-writer/src/index.ts` splits at one hard-coded level; consecutive heading blocks for one title are neither merged nor demoted (calibre demotes the second to `h3`) | 0036 |
| TOC panel: `--level1/2/3-toc`, `--toc-threshold`, `--max-toc-links`, `--duplicate-links-in-toc`, `--use-auto-toc`, `--toc-filter`, `--no-chapters-in-toc`, `--epub-inline-toc`, `--toc-title` | Nav is a flat list of headings (`navXhtml`), outline is used when present, printed TOC text is only normalized (`normalizePdfToc`), and the extracted PDF outline is **never used**; no link-derived TOC, no filtering, no inline TOC | 0037 |
| Heuristics: blank-paragraph deletion, scene-break formatting/replacement, `--smarten-punctuation`, ligature decoding | None present | 0038 |
| `--search-replace` file, `--sr1..3`, `--pdf-header-regex`, `--pdf-footer-regex` | No user pattern rules at all | 0039 |
| Metadata panel (`--publisher`, `--comments`, `--series`, `--isbn`, `--pubdate`, `--title-sort`, …), `--read-metadata-from-opf`, `--insert-metadata` | CLI accepts only `--title --author --language --identifier`; `packageXml()` writes `dc:identifier/title/language/creator/dcterms:modified` only | 0040 |
| `--flow-size` (260 KB default), `--dont-split-on-page-breaks` | Single hard-coded heading-level split; a 2000-page PDF with few headings becomes one giant XHTML file | 0041 |
| `--extra-css`, `--no-default-epub-cover`, `--preserve-cover-aspect-ratio`, `--epub-max-image-size WxH`, `--start-reading-at` | Fixed internal stylesheet; cover policy not selectable; `--max-image-size` is longest-edge only; no reading-start landmark | 0042 |
| `--add-alt-text-to-img`, `--prefer-metadata-cover`, `--remove-first-image` | No alt text is read from PDF images/tagged content at all; no cover candidate detection | 0043 |
| `--debug-pipeline <dir>` (`input/`, `parsed/`, `structure/`, `processed/`), `--verbose` levels | Progress messages only; no stage artifacts | 0044 |
| (not a calibre feature — calibre's PDF input does not extract tables either) PDF table extraction | Model and all three writers already render `TableNode`; no PDF producer exists, so `type: 'table'` never appears from `packages/pdf-reader` | 0045 |

Subtask order: 0033 → 0034 and 0036 → 0037 are the only required sequences; every
other subtask can start independently. Recommended first slices are 0044 (diagnostics
make every later change measurable), then 0032/0033, then 0036/0037. 0045 (PDF tables)
was added later at the user's request and shares no sequence with the rest. All subtasks
list this task in `Depends on:`, so absent a direct user request for a specific subtask,
this record must be accepted and set to `done` before dependent work starts.

## Acceptance Criteria

- Every calibre option in the table above is either implemented by a linked subtask or
  explicitly rejected below with a written reason, so the decision is not re-litigated.
- The gap map and the adopt/reject decisions below are reviewed and accepted, after which
  **this task is `done`**: it is the decision record for 0032–0044, not an implementation
  task, so it must not stay `in_progress`/`open` for the duration of the epic.
- New behaviour is opt-in or confidence-gated; nothing is silently deleted from the
  document. Every automatic change emits a deterministic warning code and, where the
  underlying evidence is spatial (furniture, indents, headings), stays reviewable
  through the existing SPA analysis flow.
- Default output for `tests/fixtures/pdf/` is unchanged unless a subtask explicitly
  changes a default, justified by before/after fixture evidence recorded in that
  subtask's Agent Notes.
- Calibre is used only as an offline comparison oracle during development; conversion
  quality changes are backed by corpus fixtures, and per-subtask comparisons against
  `ebook-convert book.pdf out.epub` for the same fixture are summarized in Agent Notes.
- CLI-facing options update `apps/cli/src/cli.ts` help, `documentation/cli.md`, and
  `README.md` together, per `AGENTS.md`/`CLAUDE.md`.
- New security-relevant surfaces (user regexes, extra CSS, stage dumps, larger page
  budgets) are added to the `documentation/hardening.md` requirement-to-test matrix.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass per subtask.

## Implementation Notes

- Pipeline ownership stays where it is: extraction in
  `packages/pdf-reader/src/pdfjs.ts`, deterministic analysis in
  `packages/pdf-reader/src/index.ts`, publication shape in
  `packages/epub-writer/src/index.ts`. Transform ideas that are format-neutral belong
  in a new module operating on `DocumentModel` blocks, not in the PDF reader, so DOCX,
  Markdown, and HTML imports benefit too.
- Keep the ordering contract: extraction → furniture/crop → line grouping → paragraph
  merging → text normalization → structure detection → chaptering → rendering. Each
  stage takes explicit typed options and emits warnings; no stage reads globals.
- Do not bypass `REQUIREMENTS.md` "Style analysis and heading inference" precedence or
  the "Metadata" source priority; new detectors propose values with provenance and
  confidence and remain overridable by `styleMappings` and user metadata edits.
- Preserve determinism: stable block/heading IDs, sorted iteration, no wall-clock or
  filesystem state in analysis, resource limits per page and per document following
  `DEFAULT_LIMITS`, and cancellation/progress checkpoints like `analysisCheckpoint()`.
- Privacy stays absolute: no network calls, no telemetry, no remote CSS or fonts.
- Verified against source: `github.com/kovidgoyal/calibre` tag `v9.18.0` (matches the
  locally installed `ebook-convert`) was read for
  `ebooks/conversion/plumber.py` (pipeline stages, `--debug-pipeline` writes
  `input/`, `parsed/`, `structure/`, `processed/` plus `README.txt`),
  `ebooks/conversion/preprocess.py` (search & replace, `Dehyphenator`, ligatures,
  smarten/asciiize), `ebooks/conversion/utils.py` (`HeuristicProcessor`: nbsp indents,
  chapter markup, blank-paragraph analysis, unwrap, scene breaks, heading renumbering),
  `ebooks/pdf/reflow.py` (calibre PDF engine: header/footer auto-detection, columns,
  `coalesce_paras`/`can_merge`, outline TOC),
  `ebooks/pdf/pdftohtml.py`, `ebooks/conversion/plugins/pdf_input.py`,
  `ebooks/oeb/transforms/{structure,htmltoc,page_margin,alt_text,cover,split}.py`,
  `ebooks/oeb/polish/split.py`, and `ebooks/conversion/plugins/epub_output.py`. Subtask
  notes cite the specific file for each adopted behaviour so the next agent does not
  re-derive it, and where the source and the manual disagree the source wins.
- Licensing: calibre is GPLv3. Use `ebook-convert` only as an external comparison
  command during development. Do not vendor, link, import, or transliterate calibre
  source; implement from documented behaviour and repository fixtures. `THIRD_PARTY_
  NOTICES.md` must not gain a calibre entry unless that policy changes deliberately.
- Fixtures: extend `scripts/generate-pdf-fixtures.mjs` and
  `tests/fixtures/pdf/corpus.json` (see existing `covers`/`expectedEquations`
  conventions) rather than adding hand-written expectations only.
- Rejected (with reasons):
  - XPath rule options (`--chapter`, `--level1/2/3-toc`, `--page-breaks-before`,
    `--start-reading-at`). No XPath engine exists on the browser/CLI path and
    arbitrary expression cost is unbounded. Use typed predicates over
    `DocumentModel` blocks (heading level, text pattern, style id, page range) instead.
  - Device profiles and the CSS/font rescaling suite (`--input-profile`,
    `--output-profile`, `--base-font-size`, `--font-size-mapping`,
    `--disable-font-rescaling`, `--line-height`, `--minimum-line-height`,
    `--change-justification`, `--insert-blank-line*`, `--remove-paragraph-spacing*`,
    `--margin-*`, `--filter-css`, `--expand-css`, `--transform-css/html-rules`,
    `--linearize-tables`). These normalize an author's stylesheet that WordConvert does
    not ingest; the EPUB writer emits its own small stylesheet from a semantic model.
    Revisit only if the model starts preserving source type scale and alignment.
  - `--embed-font-family`, `--embed-all-fonts`, `--subset-embedded-fonts`: font
    licensing and bundle-size risk, and conflicts with the "no remote fonts" rule.
  - `--epub-version 2`, `--epub-flatten`, `--no-svg-cover`, `--asciiize`,
    `--keep-ligatures`, `--italicize-common-cases`, `--disable-italicize-common-cases`,
    `--rating`, `--tags`, `--timestamp`, `--insert-metadata`: rejected as low value or
    actively harmful to reflowable output. EPUB 2 emission stays an open decision item
    requiring evidence of a target reader (the archive-preserving EPUB shrink path
    already *reads* NCX, which covers the common repair case).
  - `--input-encoding` for PDF: PDF text arrives through decoded CID fonts, so a
    declared input encoding is meaningless. HTML/Markdown text imports stay UTF-8 only.
  - PDF vector-artwork extraction (figures as standalone images from path data): calibre
    explicitly does not do this either, and rendered-figure rasterization already covers
    the practical cases. Table extraction was originally rejected in this list and is now
    adopted as 0045 at the user's request on 2026-11-14; that task owns the design.

## Agent Notes

- 2026-11-13 pi: Created from a survey of the installed calibre 9.18.0 CLI
  (`ebook-convert in.pdf out.epub -h`, all option groups) and
  `manual.calibre-ebook.com/conversion.html`, cross-checked against
  `packages/pdf-reader/src/index.ts`, `packages/pdf-reader/src/pdfjs.ts`,
  `packages/epub-writer/src/index.ts`, `apps/cli/src/cli.ts`, and
  `documentation/cli.md`. Findings that shaped the split: the CLI currently has zero
  PDF analysis options; `splitChapters()` uses one hard-coded heading level; the EPUB
  nav is flat; OPF metadata is four fields; no alt text, de-hyphenation, scene-break,
  punctuation, or user-pattern handling exists anywhere in the pipeline. Calibre's PDF
  *engine* is weaker than this repository's, so the adopted ideas are its transform-
  stage heuristics, debugging stages, and option surface, not its extractor.
- 2026-11-13 pi: Initial version relied on `ebook-convert --help` plus the online
  manual. It has since been verified against the `v9.18.0` source tarball; three
  corrections came out of that: (1) the PDF engine does generate an NCX from the PDF
  outline, so ignoring our extracted outline is a plain gap and not parity with calibre;
  (2) `--unwrap-factor` and `--html-unwrap-factor` are two different options with two
  different algorithms (page-width ratio vs line-length percentile), which 0033 now
  separates; (3) `--renumber-headings` demotes the second consecutive `h1`/`h2` to `h3`
  rather than merging headings, so 0036 states both options explicitly.
- 2026-11-13 pi: Deliberate bookkeeping choice — this task is completable on its own once
  the adopt/reject decisions are accepted, so the epic does not deadlock the subtasks that
  depend on it. Implementation status lives in 0032–0044 and `TASKS/README.md`.
- 2026-11-14 pi: User reviewed the adopt/reject table and overturned one rejection — PDF
  table extraction is now adopted as 0045 (vector artwork stays rejected). Everything else
  in the table still awaits explicit acceptance, so this task stays `open`.
- 2026-11-13 pi: Pre-sign-off audit of this epic and the then-present subtasks 0032–0044. Every
  backticked `symbol()` referenced in 0031–0044 was checked against the repository: 65 of
  66 resolve to real code, and the remaining names are calibre Python identifiers quoted
  from `v9.18.0` on purpose. One bad reference was found and fixed — 0042 cited a
  non-existent `epubCoverImageBytes()`; our cover API is `createCoverSvg()` /
  `rasterizeCover()` / `prepareCoverImage()` in `packages/cover-generator/src/index.ts`.
- 2026-11-13 pi: Follow-up for whoever triages docs, outside this epic's scope —
  `AGENTS.md` and `CLAUDE.md` still describe the web app under `spa/src/apps/word-convert/`
  and `apps/word-convert/index.html`, but the tree contains only `apps/cli` and
  `apps/web` (controller, state, editors, content editor are `apps/web/src/*.ts`, and
  `npm run dev` is `pnpm --filter @wordconvert/web dev`). Subtasks 0032–0044 say "the SPA"
  without a path, so they are unaffected, but an agent following `AGENTS.md` literally will
  look for directories that do not exist.
- 2026-11-15 pi: Resumed at user request. 0033/0034 and the user-requested 0045 table
  work are implemented; 0047 resolves the default-layout precedence issue. The remaining
  gap-map items are still planned or open. This task's acceptance criterion requires the
  adopt/reject map itself to be explicitly accepted, so the task is blocked pending that
  sign-off rather than treating "continue" as approval of every remaining proposal.
- 2026-11-15 pi: User explicitly accepted the current adopt/reject map and subtask plan.
  Decision record closed; implementation status remains tracked in the individual tasks.
