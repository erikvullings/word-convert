# 0042 Add EPUB styling cover and navigation landmark output options

Status: open
Priority: low
Owner: unassigned
Agent: pi
Subsystem: epub-writer
Depends on: 0031

## Context

Calibre's EPUB output panel controls how the generated book presents itself:
`--extra-css`, `--no-default-epub-cover`, `--preserve-cover-aspect-ratio`,
`--epub-max-image-size=WxH`, `--toc-title`, `--no-svg-cover`, `--flow-size`, and
`--start-reading-at`. WordConvert implements a fixed subset of this behaviour with no
user control:

- `packages/epub-writer/src/index.ts` has one hard-coded internal stylesheet; a user who
  wants serif-vs-sans, a different measure, or heading spacing must post-process the
  ZIP;
- the cover is always produced when assets allow it (`coverXhtml()` plus
  `@wordconvert/cover-generator`), with no documented choice between source image,
  generated typographic cover, supplied file, or none;
- image capping is longest-edge only (`--max-image-size`) while calibre caps
  width **and** height, which matters for full-page scans and wide plate images;
- the nav document has `epub:type="toc"` only: no landmarks, so reading systems cannot
  jump to the cover, title page, or where reading actually starts, and PDF-derived books
  lose their printed page numbers entirely even though the reader detects page-number
  furniture candidates.

## Acceptance Criteria

- **Extra CSS:** an output option appends user CSS (inline string or local file path)
  after the generated stylesheet, with a size limit and validation that rejects
  `@import`, remote `url()`, `expression()`, and any construct that would make the EPUB
  fetch a remote resource; violations produce a deterministic warning naming the rule and
  drop only the offending declaration.
- **Cover policy:** an explicit `cover: source | generated | file | none` option (with
  `--no-default-epub-cover` equivalent) drives `@wordconvert/cover-generator`; `source`
  uses a detected cover candidate (0043), `file` follows the existing local-image
  containment and signature rules, `none` omits the cover image and its spine entry while
  always keeping the semantic title page.
- **Cover scaling:** preserve-aspect-ratio is selectable for the rasterized/SVG cover and
  documented, with the letterbox-vs-crop consequence stated in help text.
- **Image caps:** add explicit width × height capping alongside the existing longest-edge
  `--max-image-size`, keeping current flags working and keeping encoding media type,
  generated extension, and manifest declarations consistent per `AGENTS.md`.
- **Reading-system navigation:** emit EPUB 3 `landmarks` navigation (cover, title page,
  start of body) and, when printed page numbers were detected, a `page-list` navigation
  with `epub:type="pagebreak"` `id`-bearing span markers in reading order; when detection
  confidence is insufficient, emit neither rather than a fabricated list, and warn.
- All options are typed writer options (usable from the worker and the CLI), validated,
  and covered by `packages/epub-writer/src/index.test.ts` plus CLI tests; `--help`,
  `documentation/cli.md`, and `README.md` change together.
- `documentation/hardening.md` records the user-CSS boundary (this is the first user-
  supplied stylesheet the product writes into an output file).

## Implementation Notes

- Keep the generated stylesheet as the base and treat user CSS as appended text only;
  never parse-and-reserialize it beyond validation, so author intent survives and the
  output stays byte-deterministic.
- Validate user CSS with the dependency already used for CSS work in this repository
  (`apps/cli/src/css-tree.d.ts` indicates a CSS parser is present) rather than adding one.
- Cover policy belongs to the writer/cover-generator boundary: `imageResizer`-style
  adapters are already injected for image work, so follow that pattern for rasterization
  rather than importing browser globals into the writer.
- `start-reading-at` is expressed as landmarks and spine position, not as a removed
  prefix of the book; do not silently drop front matter to emulate it.
- `page-list` markers must reuse the existing furniture candidate data
  (`PdfFurnitureCandidate` with `kind: 'page-number'`) and the same detected page numbers
  the SPA shows; do not re-detect page numbers in the writer, and pass them through the
  model as explicit page markers.
- Coordinate the `--epub-max-image-size` naming with the existing `--max-image-size`,
  `--image-quality`, and `--image-format` flags so the whole image surface stays coherent
  for both the conversion path and the EPUB shrink path.
- Verified against calibre v9.18.0 for the four adopted options:
  `DetectStructure.detect_start_reading()` (`ebooks/oeb/transforms/structure.py`) stamps
  an `id` on the matched element and points the OEB **guide** `text` entry at it — the
  EPUB 3 equivalent is a landmarks entry plus spine position, which is what this task
  requires;
  `ebooks/oeb/transforms/cover.py` owns `no_default_cover`, `no_svg_cover`, and
  `preserve_cover_aspect_ratio`, and generates a title/author/series default cover via
  `ebooks/covers.py` (we keep our own `createCoverSvg()`/`rasterizeCover()` composition
  rules from `@wordconvert/cover-generator` instead);
  `epub_max_image_size` is applied with `RescaleImages(check_colorspaces=True)` in
  `epub_output.py`, i.e. as an explicit second rescale pass separate from the reader's
  image optimization, so keep our two paths (reader `maxImageSize` and writer
  `--epub-max-image-size`) independent and documented rather than merged;
  and the inline TOC lives in `ebooks/oeb/transforms/htmltoc.py` with `style` (`nested`)
  and `position` (`end`) plus `toc_title`, `epub_toc_at_end` — the shape our
  `--toc-inline`/`--toc-at-end`/`--toc-title` options mirror (0037 owns the content, this
  task only the presentation).

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Lowest priority in the epic except for user CSS,
  which users ask for often and which is small if the validation boundary is kept strict.
  The `page-list` item is the one place where WordConvert can beat calibre, because the
  reader already detects printed page numbers as furniture candidates; keep it behind the
  confidence gate so a mis-detected running head never becomes a fake page list.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
