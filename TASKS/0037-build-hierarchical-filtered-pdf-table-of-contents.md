# 0037 Build hierarchical filtered tables of contents for PDF books

Status: done
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: epub-writer
Depends on: 0031, 0036

## Context

Calibre's TOC stage follows one principle: *use the source TOC when the document has
one, otherwise generate it, and let the user override either way* — `--use-auto-toc`,
`--no-chapters-in-toc`, `--toc-threshold` (default 6) plus `--max-toc-links` (default
50) and `--duplicate-links-in-toc` to fall back to in-document hyperlinks when few
chapters exist, `--toc-filter` to drop junk entries and their children, `--toc-title`,
and `--epub-inline-toc` / `--epub-toc-at-end` for a visible contents page.

WordConvert's current state:

- `packages/pdf-reader/src/pdfjs.ts` reads the PDF **outline/bookmarks**
  (`readOutline()`, stored on `RawPdfDocument.outline`) and `analysePdf()` never uses
  it — bookmarked books lose their real structure.
- `navXhtml()` in `packages/epub-writer/src/index.ts` emits a *flat* `<ol>` of every
  heading at every level, so a nested book reads as a wall of entries.
- `normalizePdfToc()`/`parsePdfTocEntries()` in the PDF reader only recognize printed
  TOC lines with numbered prefixes and dot leaders, and rewrite them as links; other
  printed TOC layouts stay literal text.
- No entry filtering, no configurable title, no inline contents page, no link-derived
  fallback, no way to prefer generated over embedded structure.

## Acceptance Criteria

- The PDF outline becomes a real structure source: outline items are resolved to
  pages/positions, attached to the nearest heading or spine position with provenance and
  confidence, and used as the TOC in preference to headings, matching calibre's
  "source TOC wins" rule.
- An explicit `toc.source` option (`automatic | embedded | generated | off`) reproduces
  `--use-auto-toc` and `--no-chapters-in-toc`, with warnings stating what was chosen and
  why.
- EPUB nav, EPUB inline contents, HTML contents, and Markdown contents render nested
  `ol` structures that follow heading level or outline nesting, keep stable generated
  fragment ids, and never exceed the declared heading depth.
- When fewer than a configurable chapter threshold is detected (default documented),
  in-document links and recognized printed-TOC lines are used as TOC entries up to a
  configured maximum, with duplicate labels allowed only when destinations differ
  (`--duplicate-links-in-toc` equivalent). External links are never used as TOC entries.
- `tocFilter` (bounded pattern, see 0039 for the shared regex budget) removes matching
  entries and their descendants, reports the count, and never empties a TOC down to
  nothing without a warning and a fallback to the unfiltered list.
- An optional inline contents page can be emitted at the start or end of the book with a
  configurable title, in all three writers, without duplicating the semantic title page
  or the nav document.
- Printed-TOC recognition handles more than dot leaders (leaderless
  `Title .... 12`, `Title 12`, tab-separated) without converting ordinary numbered
  paragraphs into TOC entries; false-positive fixtures are required.
- Deterministic output for the corpus, `REQUIREMENTS.md` "EPUB output" and
  "Generate table-of-contents entries from semantic headings" stay satisfied, and the
  archive-preserving EPUB shrink path is untouched.

## Implementation Notes

- Structure the TOC as a first-class, model-level concept (e.g. a `toc` array of
  `{ label, target, level, provenance, confidence }` on `DocumentModel`) instead of
  deriving it from headings inside the writer; today `collectHeadings()` in
  `packages/epub-writer/src/index.ts` is the only hierarchy-free source and each writer
  re-derives its own.
- Resolve outline destinations through the existing destination handling in
  `pdfjs.ts` (`readOutline()` already receives PDF.js items); keep destination
  resolution out of the analysis stage and never trust destination strings as URLs.
- Verified against calibre v9.18.0, which raises this task's priority: calibre's *PDF
  engine* does use the outline, contrary to its own manual. `PDFDocument.generate_toc()`
  in `ebooks/pdf/reflow.py` walks the `<outline>` elements pdftohtml emitted from PDF
  bookmarks, adds each as an entry pointing at `index.html#page_N`, and writes `toc.ncx`
  whenever it collected **more than two** entries. Our reader already parses the same
  bookmarks into `RawPdfDocument.outline` and then ignores them, so wiring the outline
  in is closing a gap, not matching a calibre limitation.
- `DetectStructure.create_toc_from_links()` in `ebooks/oeb/transforms/structure.py` is
  the reference for the link-derived path and confirms the guard design: it runs only when
  detected chapters are fewer than `toc_threshold` (**6**), stops after `max_toc_links`
  (**50**) entries, and skips a candidate whose text already appears in the TOC unless
  `duplicate_links_in_toc` is set. Adopt those numbers as our starting constants and make
  each configurable; `use_auto_toc` is the explicit override that forces the link TOC even
  when chapters exist, so document and test the precedence
  (user override > embedded outline > headings > links).
- Reuse heading id generation in one place so nav, inline TOC, `normalizePdfToc()` links,
  and heading anchors cannot disagree; keep collision suffixes (`base-2`) stable.
- Inline contents must be a generated spine document declared in the manifest, excluded
  from TOC self-reference, and covered by the EPUB validity tests in
  `packages/epub-writer/src/index.test.ts`.
- CLI: `--toc-title`, `--toc-inline`, `--toc-at-end`, `--no-toc-embedded`,
  `--max-toc-links`, `--toc-filter`; update help, `documentation/cli.md`, and README
  together.
- Tests: fixtures for embedded outline (nested), printed TOC variants, few-headings +
  internal links, filtered entries, and a hostile outline (deep nesting, cyclic
  destinations, oversized titles) with resource limits.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. The single highest-value item here is wiring the
  already-extracted PDF outline into analysis: `readOutline()` is currently dead data,
  which also explains why bookmark-heavy PDFs produce weak EPUB navs. Keep the writer
  dumb — it renders the model's TOC rather than inventing one — and note that the EPUB
  shrink path has its own TOC generation from headings (`documentation/cli.md`) that
  should keep its independent behaviour.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
