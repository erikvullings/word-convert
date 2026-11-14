# 0041 Split oversized EPUB chapters by content size

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: epub-writer
Depends on: 0031

## Context

Calibre splits the generated XHTML into files no larger than `--flow-size` (default
**260 KB**, the Adobe Digital Editions limit) and can additionally split at every page
break (`--dont-split-on-page-breaks` opts out). This exists because reading systems
struggle with single large documents.

WordConvert splits only by heading level in `splitChapters()`
(`packages/epub-writer/src/index.ts`). Consequences for PDF input specifically:

- a scan-free but heading-poor PDF (essay, manual, report with only two or three
  headings, or a document whose openers are unstyled — see 0036) produces one multi-
  megabyte chapter file, which is exactly the case calibre's `--flow-size` exists for;
- the reader already emits `{ type: 'pageBreak' }` blocks at page boundaries
  (`packages/pdf-reader/src/index.ts`, rendered by both writers), but chaptering ignores
  them, so an obvious safe boundary is unused;
- there is no way to opt out, and no warning when a chapter is implausibly large.

## Acceptance Criteria

- A documented maximum serialized XHTML size option (default chosen from a measured
  reading-system-safe value) causes oversized chapters to be split into additional
  spine documents, with `0`/`off` disabling size-based splitting entirely.
- Split candidates are chosen in a fixed priority order — heading of any level, then
  `pageBreak` block, then paragraph boundary — and are forbidden inside list items,
  table rows, blockquotes, figure/image blocks, and equation blocks, preserving the
  existing "avoid invalid splits" rule.
- Spine order, generated file names, manifest entries, nav entries, an optional inline
  contents page, and every cross-chapter fragment link stay correct after a size split:
  a heading that moved into a new file is reachable from other chapters and the moved
  anchor ids remain unique and stable.
- A deterministic warning reports how many files were added by size splitting; when a
  single unbreakable block (huge table, large code block, oversized figure caption run)
  exceeds the limit on its own, output still succeeds with a warning instead of looping
  or truncating.
- Serialized files respect the limit within a documented tolerance (inline styles and
  generated markup are counted, not just text), verified by fixture assertions rather
  than by assumption.
- Splitting is deterministic: identical bytes for identical input, no dependence on
  wall-clock, and no change to output for the current corpus while the default keeps
  existing files under the limit.
- CLI flag (for example `--flow-size <kb>`, plus a page-break split toggle) documented
  in `--help`, `documentation/cli.md`, and `README.md`.

## Implementation Notes

- Keep all of this inside the writer's chaptering step: `splitChapters()` should take a
  budget and return the same `Chapter[]` shape so `packageXml()`, `navXhtml()`,
  `collectHeadings()`, and `chapterXhtml()` need only follow the ids/paths.
- Measure size after rendering the block fragment, not by character counting, or account
  explicitly for the difference in a documented tolerance.
- Anchor handling is the risky part: `collectHeadings()` assigns ids per chapter path and
  `resolveEpubHref()` resolves intra-book links — make heading ids assigned once, globally
  (shared with 0037's model-level TOC) so a split cannot invalidate a reference.
- Prior art for link rewriting across files lives in the archive-preserving path
  (`apps/cli/src/epub-structure.ts`, `apps/cli/src/epub-references.ts`); reuse the
  *reasoning*, not the code, since that path must preserve unknown author markup and this
  path generates all of it.
- Asset deduplication must be unaffected: split files reference the same manifest assets.
- Tests: a heading-poor long fixture from `scripts/generate-pdf-fixtures.mjs`, a fixture
  with a huge table, cross-chapter links to a heading that ends up split, and the
  disabled/`0` path.
- Verified against calibre v9.18.0: `ebooks/conversion/plugins/epub_output.py` calls
  `Split(not opts.dont_split_on_page_breaks, max_flow_size=opts.flow_size * 1024)` from
  `ebooks/oeb/polish/split.py`, with `flow_size` recommended at **260** KB (the documented
  Adobe Digital Editions figure) and `0` disabling size splitting. Note the default is
  that page-break splitting *is* performed (`dont_split_on_page_breaks` defaults to
  false). For us, PDF conversion never emits `pageBreak` blocks today, so a new
  `--dont-split-on-page-breaks` only becomes meaningful once 0036 can emit chapter page
  breaks; keep today's behaviour as the default and honour `pageBreak` blocks when
  present.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Independent of the reader work, but pairs naturally
  with 0036/0037 — if chapter detection produces good headings this task matters less, and
  if it cannot (heading-poor PDFs) this is what keeps the EPUB readable. Measure before
  choosing the default budget; the existing EPUB writer tests already assert ZIP layout
  and manifest content, so extend rather than replace them.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
