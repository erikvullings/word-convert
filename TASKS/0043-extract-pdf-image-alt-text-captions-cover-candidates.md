# 0043 Extract PDF image alt text captions and cover candidates

Status: open
Priority: low
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031

## Context

Calibre's structure-detection panel includes image-related fixes:
`--add-alt-text-to-img` (fill a missing `alt` from metadata carried with the image file,
explicitly justified as an accessibility feature), `--prefer-metadata-cover` (use a cover
detected in the source in preference to a generated one), and `--remove-first-image`
(drop a source cover that is not identified as a cover, so it does not duplicate the
real cover).

WordConvert's PDF image path extracts pixels and geometry but no meaning:

- `imageBlock()` in `packages/pdf-reader/src/index.ts` never sets `alt`, even though
  tagged PDFs carry `/Alt` and `/ActualText` on marked-content image elements and
  `RawPdfPage.taggedStructure` plus `span.markedContentId` already exist;
- `ImageBlockNode.caption` is supported by both writers (`figcaption` / `<caption>`
  styling exists in `packages/epub-writer` and `packages/html-writer`) but the PDF reader
  never fills it — `imagePlacements()` only uses the detected `Figure N:` line to order
  the image, leaving the caption as an unrelated paragraph;
- no cover candidate is produced, so `--cover`/`cover: source` (0042) has nothing to
  select and books whose first page is a full-page cover image show that image twice
  (once as content, once as the generated cover).

## Acceptance Criteria

- Alt text is populated from tagged-PDF image properties (`/Alt`, falling back to
  `/ActualText` where the role makes that appropriate) and, when present, from embedded
  image XMP accessibility fields, matched to images by marked-content id rather than by
  geometry guessing.
- Sanitized alt text reaches `ImageBlockNode.alt` and inline image alt in all writers;
  missing alt produces no fabricated text, and a deterministic warning reports how many
  images lack a description.
- Figure captions detected by `isFigureCaption()`/`captionFigureRegions()` logic become
  `ImageBlockNode.caption` on the image they describe (rendered as `figcaption`), the
  standalone caption paragraph is not duplicated, and unattached captions remain ordinary
  paragraphs.
- A cover candidate is detected from a first-page (or early-page) near-full-page image
  that passes an aspect-ratio and size heuristic, exposed with page, asset id, coverage,
  and confidence; a source-derived cover is preferred over a generated one only at high
  confidence, and an explicit `removeFirstImage`-equivalent option prevents duplicated
  covers.
- All heuristics are reviewable in the SPA (image list with detected alt, caption, cover
  confidence) and overridable through existing model editing, matching how formula and
  furniture review already work.
- Fixtures: tagged PDF with `/Alt` on figures, image with XMP alt metadata, captioned
  figure (above and below), full-page cover page, and a hostile case (oversized alt
  string, markup-looking alt text, image with no marked-content link).
- `THIRD_PARTY_NOTICES.md` is untouched unless a new dependency is genuinely required.

## Implementation Notes

- Extend `readStructure()` in `packages/pdf-reader/src/pdfjs.ts` to keep marked-content
  properties (role plus `/Alt`, `/Lang`, `/ActualText`) instead of roles only, and check
  whether PDF.js exposes alternate text on the page's structure tree or operator list
  before adding any low-level parsing.
- Bound alt/caption strings with an explicit character limit and sanitize to plain text
  (the model's `alt` is an attribute; markup must never survive into writers).
- Caption attachment must reuse the existing geometry helpers in `pdfjs.ts`
  (`captionFigureRegions()`, `isFigureCaption()`, `isFigureCredit()`,
  `hasFollowingFigureCaption()`) and `imagePlacements()` rather than adding a second
  caption detector, and must keep the credit line separate from the caption.
- Cover candidate detection belongs in the analysis result (`PdfAnalysisSummary`) next to
  `imageBackedPages`, not in the EPUB writer, so the SPA, CLI, and cover generator all see
  the same value.
- Keep rendered-figure/page-raster assets out of cover and alt heuristics: only
  `source: 'embedded'` images are cover candidates.
- Coordinate `alt`-vs-`figcaption` semantics with the DOCX reader so both producers fill
  the same fields the same way.
- Verified against calibre v9.18.0: `ebooks/oeb/transforms/alt_text.py` fills an empty
  `alt` by decoding the image bytes with PIL and calling
  `calibre.utils.img.read_alt_text()`, i.e. it reads alt text **embedded in the image
  file's own metadata** (XMP/description) and does nothing for SVG. That is a strict
  subset of what this task plans: the PDF's tagged Markup Access (`/Alt`, `/ActualText`,
  `/Lang`) and XMP are our primary sources, with image metadata as a further fallback.
  `ebooks/oeb/transforms/cover.py` is the reference for `prefer_metadata_cover` and
  `remove_first_image` semantics (cover detection, dimensions via `inspect_cover()`).

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Small, self-contained, and the accessibility item
  (`alt`) is the most defensible change in the epic. Depends on none, but the cover
  candidate is a prerequisite for `cover: source` in 0042 — sequence them together if
  0042 starts first.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
