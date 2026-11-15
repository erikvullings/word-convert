# Local command-line conversion

WordConvert's CLI shares the SPA's semantic readers and writers instead of
maintaining a separate conversion engine. It accepts **local DOCX, PDF, Markdown, and HTML**
files and produces standalone HTML, HTML ZIP, Markdown, Markdown ZIP, or EPUB.
Existing local EPUB files support image optimization, missing-TOC repair, and
optional chapter organization without rebuilding through the semantic model.
Remote imports, interactive editors, and full-page text OCR are not included.
PDF layout analysis and GPU selection are automatic. Missing model assets are
downloaded once with a warning, then cached; document content stays on-device.
Use `--offline` to prohibit all network requests, or `--no-layout` for basic PDF
conversion without a model or native runtime.

## Pipeline diagnostics

`--verbose` is repeatable up to twice. The first level reports elapsed time and
object counts for each conversion stage to stderr; the second adds a sanitized
applied-option summary and the selected inference provider/model. It never
changes stdout. `--debug-pipeline <dir>` implies the first verbosity level and
writes these versioned (`schema: 1`) artifacts from the same objects the
conversion uses, without running a second reader or writer pass:

| Artifact | Contents |
| --- | --- |
| `0-request.json` | Effective options with filesystem paths reduced to basenames |
| `1-raw.json` | PDF pages, spans, geometry, links, fonts, tagged structure and image size/SHA-256 references |
| `2-analysis.json` | PDF crop, furniture candidates, scanned/image-backed/dense/fallback pages, formula candidates/image regions and tables |
| `3-model.json` | Final semantic model, styles, metadata, equations, warnings and asset size/SHA-256 references |
| `4-output/` | Pre-packaging writer artifacts (such as XHTML/HTML, CSS, EPUB package and navigation files); `assets.json` lists writer assets by size, SHA-256, and inclusion status |

DOCX and text readers do not expose a raw-PDF or PDF-analysis stage, and the
archive-preserving EPUB shrink path does not construct a semantic model; those
stage files explicitly say `not-applicable`. The requested dump directory must
not already exist, its parent must exist, and it cannot be the input file's
directory or an ancestor of that directory; the conversion output also cannot
be placed inside the dump. By default it must be inside the
current working directory. `--force` permits a location outside that directory,
but does not relax the input-directory boundary. The tool creates the dump
directory with private permissions; a dump write failure warns on stderr and
does not fail or alter conversion output.

Pipeline dumps contain document text and can reveal sensitive content. Review
and protect them before sharing. The dump metadata adds no timestamp, absolute
filesystem path, or machine hostname. By default, binary assets are not copied:
binary stage-4 files are omitted, and base64 data URLs are replaced by
`wordconvert-asset-ref` markers. Use `--debug-pipeline-assets` with
`--debug-pipeline <dir>` to include the exact stage-4 writer artifacts, including
embedded assets; this opt-in does not include raw/model assets in their JSON
stages. `assets.json` records size, SHA-256, and whether each stage-4 asset was
included. JSON stages are allowlisted and bounded; long text/collections are
truncated with `"truncated": true`. Without the opt-in, other writer text
artifacts are preserved byte-for-byte. No pretty-printed variant is emitted
because these writers do not expose a separate readable rendering.

## Markdown and HTML input

```sh
wordconvert notes.md                 # notes.epub
wordconvert article.html -o book.epub
wordconvert notes.markdown -f html -o notes.html
```

Inputs `.md`, `.markdown`, `.html`, `.htm`, and `.xhtml` are UTF-8 text under
the same 50 MiB input limit. They use the semantic model and existing writers,
so all five output formats work without native libraries or model downloads.
Headings, emphasis, lists, quotes, code, GFM tables, and Markdown TeX formulas
are retained. Markdown imports use `marked`; `slimdown-js` is used only for the
SPA's rendered Markdown preview, not EPUB conversion. Exported bold labels such
as `**Abstract: **In this paper...` and `**Abstract:**In this paper...` are
accepted without exposing asterisks in output; escaped markers and code remain
literal. HTML emphasis is preserved directly as semantic marks, including
trailing whitespace and adjacent text, rather than round-tripping through
Markdown emphasis delimiters.
HTML title, language and author metadata are read when present;
otherwise title derives from the first H1/filename, language defaults to
English, and a deterministic source SHA-256 identifier is generated.

Local images must be relative to the input directory (including subfolders).
Symlink and `..` escapes, absolute paths, and `file:` URLs are not loaded.
Remote image URLs are disabled by default. PNG, JPEG, GIF, WebP, and AVIF images are checked by signature,
limited to 100 images, 10 MiB each, and 50 MiB total, and embedded using
generated writer asset paths. Valid bounded data-URI images are supported.
Unavailable images retain alternative text and a warning. Output cannot
overwrite an included source image, even with `--force`.

To embed external images, opt in explicitly:

```sh
wordconvert article.html --include-external-images -o article.epub
wordconvert notes.md --include-external-images
```

Only credential-free HTTPS on port 443 is allowed, including protocol-relative
URLs. DNS must resolve exclusively to public addresses, and the connection is
pinned to a validated address with normal TLS certificate verification.
Private/local networks, insecure redirects, active image types, and compressed
responses are rejected. Each image has a 15-second deadline (including at most
three redirects) and the same streaming byte and signature limits as local
images. No cookies, authorization, or referrer are sent; image hosts can still
observe your IP address and requested URLs. Images are embedded, not hotlinked,
and never cached to disk. A rejected or failed opted-in download is skipped with
a per-image warning; alternative text and the rest of the article are retained.
Local image validation and aggregate image budgets remain strict.
The flag is for Markdown/HTML only and cannot be combined with
`--offline`; it does not relax local-file containment.

HTML is parsed inertly without script execution, network requests, or external
entity loading. Scripts, active embeds, SVG, forms, CSS, and event handlers are
omitted with warnings. Relative/unsafe link destinations are omitted, while
safe links and text remain. HTML is a semantic import, not a pixel/style-preserving
copy: table spans are flattened with a warning, and MathML requires a TeX
`alttext` alternative for equation preservation. Inline/raw HTML in Markdown
may be retained as escaped text rather than interpreted as source styling;
exact, attribute-free `strong`, `em`, `del`, `u`, `sub`, and `sup` tags are
recognized as passive text marks.

Content selection prefers the first enclosing `<main>`, ARIA `role="main"`, or
`id="main"` landmark, then `id="content"`, `<article>`, and the document body.
This includes sibling publisher sections inside a larger main container and
content inside a page-wide server form without importing form controls.
Nested Avada/Fusion columns inside that container are retained. Publisher pages
with unusual markup or content absent from the saved HTML can still under-capture.
For Avada/Fusion pages where pandoc extracts the full report more reliably, use:

```sh
pandoc report.html -f html -t gfm -o report.md
wordconvert report.md -o report.epub
```

Pandoc is an optional, separately installed fallback, not a CLI dependency.
Neither path executes JavaScript to load missing page content.

## EPUB image size

EPUB output downscales JPEG, PNG, and WebP images whose longest edge exceeds
**1600 px**, and encodes opaque raster images as **JPEG at quality 80**,
including PNGs and images already below that dimension limit. This avoids
embedding large lossless photo PNGs. Transparency is preserved using PNG;
GIF/AVIF and images that would not shrink are kept unchanged. Pixel dimensions,
not DPI metadata, determine the reading resolution. Override with
`--max-image-size <px>` (0-32768; `0` embeds originals). The option is valid only
for EPUB output. Resizing uses the native canvas binding in `runtime/`; if it
is unavailable, a warning is printed and images are embedded unchanged.

```sh
wordconvert article.html --include-external-images --max-image-size 1200 -o small.epub
wordconvert article.html --image-quality 70 -o compact.epub
wordconvert article.html --image-format preserve -o lossless-png.epub
```

`--image-format jpeg|preserve` selects the opaque-image encoding policy;
`preserve` retains the source format (PNG stays lossless). `--image-quality
<1-100>` controls JPEG/WebP encoding quality, not pixel dimensions. Both apply
only to EPUB. `--max-image-size 0` disables all image optimization, including
format changes. Original source documents and their images are never modified.

## EPUB covers

Use `--cover <path>` to add a local JPEG, PNG, WebP, or SVG image as an EPUB
cover. Raster files are checked against their signatures and pixel limits; SVG
is sanitized before embedding. Cover files are limited to 10 MiB. This makes an
image-only cover without changing the document body:

```sh
wordconvert book.pdf --cover downloaded-cover.jpg -o book.epub
```

For a PDF whose first page is the cover, use `--frontpage-cover` instead. It
renders that page as the EPUB cover and removes the page's extracted images from
the body, so the cover image is not repeated; first-page text remains available
to the document. This option requires PDF input, EPUB output, and the native
runtime even when `--no-layout` is set. The two cover options cannot be combined,
and existing EPUB input remains optimization-only.

## Publication metadata

The following options override reader-inferred values for semantic conversions:

| Option | Value |
| --- | --- |
| `--title <text>` / `--subtitle <text>` | Main title and subtitle |
| `--title-sort <text>` / `--author-sort <text>` | EPUB title and creator file-as values |
| Repeat `--author <name>` | Replace the author list |
| `--language <tag>` | Valid BCP 47 language tag |
| `--publisher <text>` / `--description <text>` / repeat `--subject <text>` | Publisher, description, and subjects |
| `--book-version <text>` / `--rights <text>` | Publication version and rights statement |
| `--identifier <text>` / `--isbn <number>` | Package identifier and a separate ISBN-10/ISBN-13 identifier |
| `--source-created-at <ISO>` / `--source-modified-at <ISO>` / `--pubdate <ISO>` | Source creation, source modification, and publication dates |
| `--series <name>` / `--series-index <number>` | Collection name and positive position (maximum 1,000,000); an index requires a series |
| Repeat `--contributor <name>` / `--book-producer <name>` | Contributors and the book producer |
| `--metadata <file>` | Read a version 1 JSON metadata sidecar |
| `--conversion-date <ISO>` | Existing option: conversion date and default package modification date |
| `--strict-isbn` | Fail instead of warning when an ISBN checksum is invalid |

Dates accept an ISO 8601 date or timezone-qualified timestamp and normalize to
UTC second precision for EPUB output. Language tags are validated and
canonicalized as BCP 47. ISBN-10 and ISBN-13 checksums are checked; a bad
checksum is retained with a warning unless `--strict-isbn` is present.

The sidecar is UTF-8 JSON with a maximum size of 32 KiB. It accepts no unknown
keys, markup, file paths, asset data, or remote URLs. Its shape is:

```json
{
  "schema": "wordconvert.metadata",
  "version": 1,
  "metadata": {
    "title": "Field guide",
    "titleSort": "Field guide",
    "subtitle": "A practical reference",
    "authors": ["Ada Example"],
    "authorSort": "Example, Ada",
    "language": "en-GB",
    "publisher": "Example Press",
    "description": "A short description.",
    "subjects": ["Reference", "Field work"],
    "version": "2.0",
    "rights": "Copyright Example Press",
    "identifier": "urn:example:field-guide",
    "isbn": "9780306406157",
    "sourceCreatedAt": "2022-01-02",
    "sourceModifiedAt": "2023-02-03",
    "publicationDate": "2024-03-04",
    "series": "Field guides",
    "seriesIndex": 2,
    "contributors": ["Editor One"],
    "bookProducer": "Example Studio"
  }
}
```

The `metadata` object may contain any subset of the listed fields. Strings are
bounded to 16,384 characters, arrays contain at most 100 non-empty strings, and
`seriesIndex` must be greater than zero and at most 1,000,000. Dates and
language tags are validated before conversion. `conversionDate` is intentionally
not a sidecar field: set it with `--conversion-date` to keep reproducible build
settings explicit. The precedence is **CLI flag > sidecar > reader inference >
filename/derived defaults**, applied independently per field; repeatable CLI
`--subject` and `--author` values replace the sidecar list when supplied.

EPUB output uses Dublin Core elements for publisher, description, subjects,
rights, creators, contributors, and dates. Date refinements identify creation,
modification, and publication; the conversion date is also emitted as a `dc:date`,
while the required `dcterms:modified` remains independently controlled by
`--conversion-date`/the writer option and does not follow the fixed ZIP timestamp.
ISBN is an additional `dc:identifier` qualified with EPUB 3's
`identifier-type`/`onix:codelist5` refinement. Series uses
`belongs-to-collection`, `collection-type`, and `group-position`; the book
producer is a contributor with the MARC `bkp` role.

`--cover <path>` is separate from the metadata sidecar and continues through the
bounded, signature-checked cover generator. The generated `cover-image`
declaration is retained, and the semantic XHTML title page remains in the spine.

## Shrink an existing EPUB

```sh
wordconvert large.epub                      # large.shrunk.epub
wordconvert large.epub --max-image-size 1200 --image-quality 70 -o compact.epub
wordconvert large.epub --image-format preserve -o lossless.epub
wordconvert large.epub --split-chapters -o chapters.epub
```

The same default 1600 px / JPEG quality 80 policy applies to manifest-declared
PNG, JPEG, and WebP images, including covers. Transparency stays lossless;
animated PNG/WebP, GIF/AVIF, SVG, fonts, and other resources are untouched.
Chapter structure, navigation labels, styles, and metadata are preserved by
default. Converted image filenames receive the matching suffix without
overwriting existing resources. Manifest MIME types and static XHTML, SVG,
CSS, NCX, SMIL, and OPF references are updated together, including percent-encoded
paths, fragments, inline styles, and `srcset`.
Resource relocation and chapter splitting are rejected for scripted books:
JavaScript-generated references cannot be rewritten safely. Use
`--image-format preserve` or `--max-image-size 0`, without `--split-chapters`,
to avoid relocation.

An existing TOC is retained. If missing, an EPUB 3 navigation document or EPUB 2
NCX is generated from spine headings, adding collision-free heading IDs as
needed. With no usable headings, the TOC lists existing spine documents and a
warning explains the fallback. No readable XHTML spine means a warning instead
of a fabricated TOC.

`--split-chapters` is opt-in for existing EPUBs. It first coalesces short
(under 50 words) XHTML spine fragments into the next substantial document, or
the preceding one for trailing fragments. It then splits at credible H1
headings when there are at least two; otherwise repeated H2 headings are used
(one H1 often represents the book title). Short/OCR-like heading labels do not
create a chapter, and a section needs at least 50 words before another split.
This keeps title-page/preamble fragments from becoming one-line chapters.
Nested wrappers are retained, and manifest/spine order, TOCs, and cross-chapter
fragment links are updated. Without recognizable boundaries the file stays
intact. This is heading-based organization, not inference of chapters from
font size, plain paragraphs, or page breaks.

The input is capped at **256 MiB** (instead of the normal 50 MiB source cap);
ZIP limits are 10,000 entries, 64 MiB per expanded entry, 512 MiB total, and
1000:1 maximum expansion per entry. Raster decoding checks the signature and
dimensions first: 40 megapixels per image and 1 gigapixel total. XML is UTF-8,
capped at 4 MiB per container/OPF and 32 MiB per content document.
Custom DTD/entity declarations and `xml:base`/HTML base elements are rejected;
content documents may retain a simple external DOCTYPE without fetching it.
ZIP64, split archives, unsafe/duplicate ZIP paths, encrypted/font-obfuscated
packages, and signed books are rejected explicitly.

This mode uses the native canvas binding but no models or network; a missing
binding is an error when there are images to optimize. Codec failures produce
warnings and retain the original image, while invalid signatures or exceeded
resource limits fail the operation. Only smaller image encodings are used.
For image-only changes, if repacking would increase its size, the original
package is written with a warning. A book with no useful image savings is copied
unchanged unless a missing TOC is added or chapter splitting is requested.
Those structural changes are retained even if the package becomes larger.
Byte counts and percentage savings go to stderr.

Output defaults to `<name>.shrunk.epub`, not the input path. Existing output
files need `--force`; even with it, source files and their symlink/hard-link
aliases cannot be overwritten. `--output -` streams binary output.
`--max-image-size 0` disables image changes; TOC repair and optional chapter
splitting still apply.
Metadata, formula, model, and external-image import options are rejected rather
than silently ignored. EPUB input cannot produce HTML or Markdown. This is a
repackaging tool, not a sanitizer: existing scripts, remote references, metadata,
and private content are preserved, not executed or fetched.

### PDF page numbers, running headers, and footers

The shared PDF.js worker resolves fonts in each embedded Form XObject's resource
scope. A form that reuses a parent font name with a different encoding no longer
inherits that parent's character map. This fixes garbled text without a
text-only external extraction step; the regular image/figure path is retained.
It is not OCR or a guarantee of correct reading order for every PDF. Explicit
source spacing and genuinely missing or incorrect character maps can remain.

The CLI uses the shared PDF reader's automatic page-furniture detection. On
documents of at least four pages, high-confidence repeated headers, footers, and
page numbers (including odd/even variants) are omitted from extracted text.
Medium/low-confidence candidates remain to avoid deleting real content.
The cleanup warning is reported on stderr. Text baked into page images remains
visible; full-page OCR or image erasure is not performed.

PDF extraction options are independent of EPUB shrinking:

```sh
wordconvert book.pdf --list-furniture
wordconvert book.pdf --remove-furniture pdf-furniture-abc123 -o cleaned.epub
wordconvert book.pdf --keep-furniture pdf-furniture-abc123 -o reviewed.epub
wordconvert book.pdf --no-remove-furniture --no-layout -o untrimmed.epub
wordconvert book.pdf --crop-top 0.04 --crop-bottom 0.03 --no-layout
wordconvert book.pdf --no-images --no-layout
```

`--list-furniture` prints tab-separated candidate IDs, kind, odd/even page
parity, confidence, page coverage, normalized text, and the current removal
decision, then exits. It uses geometry-only analysis unless `--layout-model` is
explicitly supplied; it cannot be combined with `--format` or `--output`.
Candidate IDs derive from the reader's normalized text and page geometry and
remain stable for identical PDF bytes. Repeat `--remove-furniture <id>` or
`--keep-furniture <id>` to apply saved decisions on later conversions. Unknown
IDs are rejected. A candidate cannot be both kept and removed; explicit remove
and `--no-remove-furniture` are conflicting options. `--no-remove-furniture`
retains high-confidence automatic candidates and reports how many it retained.

User patterns can nominate only the first or last non-empty text line on each
PDF page:

```sh
wordconvert book.pdf --header-regex '^Journal of Example$' --list-furniture
wordconvert book.pdf --footer-regex '^Copyright .+$' -o cleaned.epub
```

These are reviewable `header`/`footer` candidates grouped by rule and odd/even
page parity. Coverage and confidence are calculated with the same parity-aware
rules as automatic furniture detection. Only high-confidence candidates seen on
at least two pages are removed automatically; one-off or lower-confidence
matches remain. Use the listed candidate ID with `--remove-furniture` or
`--keep-furniture` to override the automatic decision. Patterns run on page
lines before the automatic classification, but do not bypass its confidence
gate. The patterns are PDF-only.

`--crop-top` and `--crop-bottom` take fractions from 0 to 1 of each rotated
page. Their sum must be less than 0.9 so at least 10% remains. Cropping is a
reader operation and works with `--no-layout`; it changes no defaults when
omitted. `--no-images` skips PDF image extraction, including figure and
rendered-equation images, and reports the number of source image placements
omitted. It requires `--no-layout` because layout inference depends on figure
images. It cannot be combined with `--split-chapters`; the latter is exclusive
to existing EPUB input, where PDF-only extraction flags are rejected and the
EPUB shrinking path is unchanged.

EPUB shrinking removes isolated numeric or Roman-numeral paragraphs only when
they precede explicit page-break markers and at least two such page numbers are
present in that XHTML document. It also removes repeated text-only labels that
occur at least twice immediately after explicit page breaks. Ambiguous numbers
and non-repeated labels remain. This is based on embedded page-break structure,
not inferred page geometry.

### Chapter detection and marking

PDF input defaults to automatic chapter detection. It considers short, standalone
body-style lines matching chapter, book, section, prologue, epilogue, or part
keywords, and promotes them only when they repeat with structural spacing,
paragraph segmentation is trustworthy, and the document has at least 50 words.
Repeated candidates must have reasonably regular intervals. Explicit style
mappings are not overridden; uncertain candidates are reported as proposals.
Detection is disabled for non-PDF input.

```sh
wordconvert book.pdf --chapter-detection automatic --chapter-split-level 2 \
  --chapter-mark pagebreak -o book.epub
wordconvert book.pdf --chapter-detection off --chapter-mark both \
  --chapter-split-level 1 -f html -o book.html
```

`--chapter-detection` accepts `off`, `automatic` (default), or `custom`.
`--chapter-split-level` accepts heading levels 1 through 6 and defaults to 2,
preserving the existing EPUB split behavior. It selects EPUB file boundaries
and the heading level used by HTML/Markdown chapter markers. Splits and marks
occur only at top-level blocks, never within lists, tables, quotations, or
equations. EPUB represents chapter boundaries as separate XHTML files; HTML
uses page-break elements and thematic breaks, while Markdown uses a page-break
comment and thematic break.

`--chapter-mark` accepts `pagebreak`, `rule`, `none` (default), or `both`.
Marks are inserted only before subsequent chapter headings after at least 50
words of chapter content. Consecutive same-level headings are merged into one
title before splitting, including when their block styles differ; inline
formatting and numbering are retained, and the first heading's ID remains
stable. Different heading levels remain separate.

EPUB chapters are additionally split when their serialized XHTML exceeds
`--flow-size <kb>`, which defaults to **260 KiB** (266,240 bytes). The limit
counts the complete generated XHTML, including document markup, inline markup,
and escaped UTF-8 content. At a size boundary the writer prefers any heading,
then (only with `--split-on-page-breaks`) a page-break block, then a paragraph
boundary. It never splits inside a list item, table, blockquote, figure, or
equation. `--flow-size 0` or `--flow-size off` disables size-based splitting;
page-break blocks otherwise retain their current in-chapter behavior. If an
unbreakable block alone exceeds the limit, the EPUB is still written intact and
a warning reports the oversized file.

### PDF tables of contents

PDF output uses resolved embedded bookmarks first, then semantic headings.
When fewer than six chapters are detected, recognized printed-contents links
and other internal links can supplement the TOC, up to 50 entries. External
links are never TOC entries. `--toc-threshold <n>` and `--max-toc-links <n>`
change those defaults (each accepts 0-500); `--duplicate-links-in-toc` allows
the same label at different internal destinations. A bounded `--toc-filter
<pattern>` removes matching entries and their nested descendants. If a filter
would remove every entry, the original TOC is retained with a warning.

Use `--toc-source automatic|embedded|generated|off` to choose the source:
`automatic` prefers bookmarks and falls back to headings, `embedded` requests
bookmarks but warns and falls back to headings when they cannot be resolved,
`generated` ignores bookmarks, and `off` disables TOC entries. The compatibility
flags `--no-toc-embedded`, `--use-auto-toc`, and `--no-chapters-in-toc` select
generated headings, force internal-link TOC entries, and disable entries,
respectively. `--use-auto-toc` overrides source selection; it cannot be combined
with `--no-chapters-in-toc` or `--toc-source off`.

For HTML, Markdown, and EPUB, `--toc-inline` adds a visible contents section or
page; EPUB keeps its navigation document separate. The contents title defaults
to `Contents` and can be changed with `--toc-title <text>`. Use
`--toc-at-end` with `--toc-inline` to place the visible contents after the book.
These writer options also work for non-PDF input. Existing EPUB input remains on
its archive-preserving shrink path and does not use these PDF or semantic-writer
TOC options.

## Run from source

Install Node 24+, the repository's pinned pnpm, and Bun 1.3.11:

```sh
pnpm install --frozen-lockfile
pnpm cli document.docx --format html
pnpm cli document.pdf --format epub --output book.epub
pnpm cli --help
```

Output format defaults to **EPUB**. If `--output` ends in `.epub`, `.html`,
`.htm`, `.md`, `.markdown`, `.html.zip`, `.md.zip`, or `.markdown.zip`, the format
is inferred from that extension (case-insensitively). Explicit `--format` takes
precedence. An unrecognized extension or stdout (`--output -`) defaults to EPUB;
bare `.zip` is ambiguous and requires `--format html-zip` or `markdown-zip`.

Output defaults to the input directory with the corresponding extension:
`.html`, `.html.zip`, `.md`, `.md.zip`, or `.epub`. Existing files are preserved
unless `--force` is supplied. Even with `--force`, input documents, presets,
model files, and their hard-link/symlink aliases cannot be replaced.

Use `--output -` to stream the result to stdout, including binary ZIP/EPUB.
Conversion warnings, runtime diagnostics, and file-write confirmations go to
stderr. Exit codes are `0` for success, `1` for conversion/I/O failure, and `2`
for invalid arguments. Formula recognition warnings can accompany a successful
conversion: uncertain or invalid recognition retains source content.
PDF XMP creator sequences are normalized before analysis: empty entries are
ignored and nonempty names are joined in source order. Document-info author
metadata retains precedence, and `--author` overrides the analysed result.

```sh
pnpm cli document.docx --format markdown --output notes.md
pnpm cli document.docx --style-preset headings.json --title "My book" \
  --author "First author" --author "Second author" --language nl-NL \
  --identifier urn:example:book --format epub --output book.epub
pnpm cli document.docx --conversion-date 2026-11-07 \
  --formula-mode mathml --format html-zip --output publication.zip
```

Style presets use the same validated `wordconvert.style-preset` version 1 schema
as SPA exports. They apply to DOCX only. Metadata overrides have typed user
provenance. Missing or invalid document language defaults to `en` with default
provenance and a warning; a valid document language is preserved. `--language`
overrides it explicitly. Supply `--conversion-date` as a date or UTC ISO timestamp to avoid
clock-dependent output; PDF page deadlines can still affect slow documents.

## Portable executable

```sh
pnpm cli:build
./apps/cli/dist/bun-darwin-arm64/wordconvert document.docx --format epub
```

The native target is selected automatically:

| Platform | Build directory |
| --- | --- |
| Apple Silicon macOS | `bun-darwin-arm64` |
| Intel macOS | `bun-darwin-x64` |
| Linux x64, glibc | `bun-linux-x64-baseline` |
| Linux arm64, glibc | `bun-linux-arm64` |
| Windows x64 | `bun-windows-x64-baseline` |

Copy the target directory to the destination machine; no Bun, Node, pnpm, or
Python installation is required there. The executable alone supports DOCX and
basic, geometry-based PDF conversion. Optional PDF rendering/ML loads native
libraries from the sibling `runtime/` folder, or from `--runtime-dir <path>`.
The CLI resolves the real executable path before finding `runtime/`, so a PATH
symlink and an unrelated working directory do not require this flag. No
temporary runtime extraction is needed. The default PDF mode requires the
complete bundle; executable-only PDF conversion requires `--no-layout`.
Keep the licence and notice files with redistributed executables and libraries.

### Put the CLI on PATH

From a source checkout, build and install the native bundle with:

```sh
pnpm cli:install
pnpm cli:install -- --force # Update a previous script-managed installation
```

The installer copies the complete bundle to `~/.local/share/wordconvert` and
links `~/.local/bin/wordconvert` on macOS/Linux. On Windows it installs to
`%LOCALAPPDATA%/wordconvert` and prints the directory to add to your user PATH.
It does not edit shell profiles or overwrite unrelated commands/installations.
`--force` updates only directories carrying its installation marker.
Use `--prefix <directory>` and `--bin-dir <directory>` to override destinations,
or run `bun apps/cli/scripts/install.ts --bundle <extracted-bundle>` to install
an existing bundle without rebuilding (requires Bun for the installer only).

The command is `wordconvert`, not `word-convert` or `wc` (the latter is the
standard word-count utility). On macOS/Linux, copy the complete bundle to a
stable directory and symlink its executable into a directory on your PATH:

```sh
# First-time installation on Apple Silicon macOS; adjust the target as needed.
mkdir -p ~/.local/share ~/.local/bin
cp -R apps/cli/dist/bun-darwin-arm64 ~/.local/share/wordconvert
ln -s ~/.local/share/wordconvert/wordconvert ~/.local/bin/wordconvert
wordconvert --help
```

If `~/.local/bin` is not already on PATH, add
`export PATH="$HOME/.local/bin:$PATH"` to your shell configuration and open a
new terminal. Keep `runtime/` beside the installed executable. Copying the
bundle instead of linking directly into a worktree keeps the command usable
after the worktree is removed. Rebuilding the repository does not update this
installed copy; replace the installed bundle deliberately when upgrading.

### Agent usage

A `SKILL.md` is not required: agents with shell access can discover the CLI
through `wordconvert --help`. Specify local input/output paths and the desired
format, check the exit status, and review warnings on stderr. Do not use
`--force` unless replacing the output is intended. PDF layout models are cached automatically, and GPU selection defaults to
`auto`; formula OCR requires `--formula-ocr`. First-use downloads emit a
warning rather than an interactive prompt, including when invoked by agents.
Use `--offline` to guarantee no network requests. Use `--no-layout` to avoid
default layout inference, or supply explicit model paths/provider choices.
For binary formats, use an output file rather than capturing stdout as text.
This guide contains the more detailed model setup and platform restrictions.

The **Build portable CLI** GitHub Actions workflow builds and smoke-checks
native bundles on each platform. Pushing a `cli-v<version>` tag publishes all
five archives and `SHA256SUMS.txt` as a GitHub release only after every target
passes. Unix archives are `.tar.gz` to preserve executable permissions; Windows
uses `.zip`. Extract the complete target directory and keep its runtime and
licence files. Models are not bundled. Linux requires glibc; macOS and Windows
binaries are unsigned. Download the release archive or its target-specific
workflow artifact. On
macOS/Linux, restore the executable bit with `chmod +x wordconvert` if the
artifact downloader did not preserve it. These are unsigned binaries and
normal OS download/security policies still apply.

Executable-only cross-compilation is also supported:

```sh
pnpm cli:build -- --target bun-windows-x64-baseline --no-runtime
pnpm cli:build -- --target bun-linux-arm64 --no-runtime
```

Native runtime bundles must be built on the destination OS/architecture, not
combined with another platform's native libraries. Linux bundles target glibc,
not Alpine/musl. Windows arm64 is not currently a bundle target.
Intel macOS uses pinned ONNX Runtime 1.23.2, which still includes x64 native
bindings; other targets use 1.29.0. GPU availability follows each bundled
runtime and compatible local hardware.

## PDF defaults and optional formula OCR

PDF conversion defaults to native rendering and Heron layout analysis. The
basic `--no-layout` mode preserves text geometry and embedded raster images, and
reports its limitations. `--rasterize --no-layout` adds native canvas rendering for vectors,
equation crops, and page-image fallbacks without loading any ML models:

```sh
wordconvert document.pdf --rasterize --no-layout --format html
```

### First-use downloads and cache cleanup

Missing default models are downloaded from pinned HTTPS Hugging Face URLs
after a warning on stderr naming the file, size, destination, and cleanup
command. Exact byte counts and SHA-256 checksums are verified before atomic
publication; partial or failed downloads are cleaned up. Cached models are
rechecked before use. An invalid cache entry produces an error with cleanup
instructions rather than loading modified weights.

The cache contains only managed model files, never documents or output:

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Caches/wordconvert/models` |
| Linux | `$XDG_CACHE_HOME/wordconvert/models` or `~/.cache/wordconvert/models` |
| Windows | `%LOCALAPPDATA%/wordconvert/models` |

Override this with `--model-cache-dir <dir>`. Remove managed files with:

```sh
wordconvert --clear-model-cache
wordconvert --clear-model-cache --model-cache-dir /path/to/cache
```

Cleanup deletes only `heron.onnx`, `encoder.onnx`, `decoder.onnx`, and
`tokenizer.json` in that cache, not unrelated files, explicit model directories,
or the runtime bundle. Symlinked cache roots are rejected. The next default
conversion downloads missing models again. `--offline` permits verified cached
models or explicit local files, but fails if a required default model is
missing. Use `--no-layout --offline` for model-free PDF conversion.

Explicit paths bypass downloads. Use only trusted models: native model loading is
not a sandbox for arbitrary ONNX graphs. Missing or incompatible requested
models stop conversion rather than silently switching off the option.

### Heron layout analysis

The default is the official Docling Heron ONNX export at revision
`40bde044036bb181c130ddf6c51792187268748f`, approximately 164 MiB
(SHA-256 `59c81a3a2923042d85034ffc487f8f47e4854117e879aef89b2b9f728fb4922a`).
This export accepts uint8 page pixels plus original dimensions and returns
labels, scores, and pixel bounding boxes; the native adapter supports this
interface as well as the repository's FP32 raw-logit export. The shared label
mapping, detection threshold, and normalized geometry remain consistent.

You can still use a FP32 export of the same pinned Docling Heron model as the SPA.
Bun's native bindings do not support `Float16Array` inputs reliably; the SPA
retains its existing FP16 WebGPU/WASM model. Export FP32 once on a development
machine using the repository's pinned Python environment:

```sh
uv run --python 3.12 scripts/export-heron-onnx.py --fp32 \
  --output apps/cli/dist/models/heron_fp32.onnx
pnpm cli document.pdf \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

The FP32 model is approximately 164 MiB. The exporter validates its graph and
runs a real CPU inference pass. Copy this model wherever convenient on the
destination machine and pass its path with `--layout-model`. This avoids the
default download. `--no-layout` disables layout analysis entirely.

### PDF text reflow

The PDF reader preserves short lines when its geometry indicates verse or
list-like content and reports how many lines it joined versus kept as paragraph
boundaries. Tune the threshold with `--unwrap-factor <0..1>` (default `0.45`);
`0` disables length-based unwrapping, while lower values permit more joins.
The reader applies the threshold only when line endings show a dominant hard
break pattern, unless the factor is explicitly lowered below the default.
Pages whose inferred order crosses between multiple columns receive an
informational review warning; the PDF text layer is not treated as ground truth.

Word dehyphenation is opt-in. `--dehyphenate on` uses body-text evidence from
the whole document to repair line-end and in-line hyphenation, preserves
ambiguous or unsupported words, strips soft hyphens, and reports joined and
kept counts. It avoids code, links, URLs, and non-Latin word fragments; the
evidence scan is bounded. Use `--dehyphenate off` to disable it.

```sh
wordconvert book.pdf --unwrap-factor 0.4 --dehyphenate on --format epub
```

### Text normalization

The shared semantic-text pass runs for DOCX, PDF, Markdown, and HTML input.
Ligatures in U+FB00–U+FB06 and the IJ digraph characters are decoded by default;
`--keep-ligatures` preserves them. Centered curated PDF ornaments and runs of
multiple blank paragraphs become scene breaks, while single blank paragraphs
are removed only when blank-line use is sufficiently consistent. PDF page
transitions are not treated as scene breaks. Use `--scene-breaks off` to keep
ornaments and blank runs, or `--blank-paragraphs off` to preserve blank
paragraphs. A replacement is selected from a fixed marker list, never supplied
as markup:

```sh
wordconvert book.pdf --replace-scene-breaks floral
wordconvert article.html --scene-breaks off --keep-ligatures
```

Accepted replacement markers are `asterisks`, `dots`, `floral`, and `em-dash`.
Punctuation smartening is opt-in with `--smarten-punctuation`; it uses the
resolved document language (`--language` overrides it), handles nested quotes,
and leaves ambiguous apostrophes, numeric primes, and URL text unchanged.
`--unsmarten-punctuation` maps typographic quotes, dashes, and ellipses back to
straight ASCII punctuation; it cannot recover distinctions absent from the
typographic input. The two punctuation options are mutually exclusive.
Transform counts and the bounded-work result are included in a deterministic
`text-normalization-summary` warning. The pass is limited to 5,000,000 text
characters and 500,000 semantic nodes per document; code, code blocks, link
destinations, equations, and asset bytes are not rewritten.

Use `--search-replace <file>` for ordered document-wide inline text cleanup:

```text
# comments start with # (leading spaces are allowed)
old term
new term
^running footer$

```

The file is UTF-8 with alternating search and replacement lines; the blank
replacement above deletes matching text. A final line terminator is ignored,
but other blank lines are records. Search patterns are case-sensitive Unicode
regular expressions using `gu` (global, Unicode) flags, applied in file order
to each text line. Matches cannot span lines, and original URL text, link
destinations, code spans/blocks, TeX/equation sources, and asset data are
preserved. Replacements are literal plain text: `$1`, HTML, and other markup
are not expanded or interpreted.

The file is limited to 32 KiB and 20 pairs; each search is limited to 256
characters and each replacement to 1,024. Empty searches are invalid. Regexes
with backreferences, lookarounds, word-boundary assertions, quantified groups,
stacked quantifiers,
multiple variable quantifiers, empty-string matches, or quantifier bounds over
1,000 are rejected with a warning naming the stable rule ID. Invalid syntax is
also skipped with a warning. A conversion-wide pattern budget caps each input
line at 2,048 characters, total candidate lines at 50,000, total matches at
10,000, and pattern work at 1,000 ms; work checks cooperate with cancellation.
When a limit is reached, remaining text is preserved and a warning identifies
the rule. Empty paragraphs and structures emptied by a rule are dropped and
counted, including emptied list items and table cells.

### PDF tables

Tables are converted when the source states them or the geometry closes.
`--pdf-tables` selects which signals the reader may act on:

| Signal | Source | Default |
| --- | --- | --- |
| `tagged` | A `Table` element in the tagged structure tree, with its declared rows, cells, and spans | on |
| `ruled` | A closed grid of straight stroked cell borders | on |
| `borderless` | Recurring aligned columns separated by gutters, without any rules | off |

```sh
wordconvert report.pdf --pdf-tables tagged,ruled --format epub
wordconvert report.pdf --pdf-tables none --format html
```

Signals you do not name are switched off, so `--pdf-tables tagged` keeps only
tagged tables and `--pdf-tables none` keeps every table as paragraphs.
`borderless` is off by default because it infers a grid from alignment alone;
enable it only where the layout is known to hold tables, and review the result,
because lists and two-column text are close neighbours. Unknown signals and
combining `none` with a signal are argument errors, and the option requires PDF
input.

Detection never loses text and never emits a partial table: cells and captions
carry exactly the text the paragraph path would have produced, and a table that
cannot be resolved stays paragraphs with a `pdf-table-structure-unresolved` note
on stderr. Complete tagged and ruled tables take precedence over overlapping
learned picture/table proposals when page geometry is trustworthy. Image-only
table artwork and pages with untrustworthy geometry retain the layout figure path.

### TexTeller formula OCR

Enable OCR with `wordconvert document.pdf --formula-ocr`. It downloads and
caches the pinned TexTeller q4 encoder, decoder, and tokenizer on first use.
Formula OCR remains optional and is not full-page text OCR.

Alternatively, supply a directory containing `encoder.onnx`, `decoder.onnx`, and
`tokenizer.json` from the pinned TexTeller q4 export. Download manually:

```sh
mkdir -p apps/cli/dist/models/texteller
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/onnx/encoder_model_q4.onnx \
  --output apps/cli/dist/models/texteller/encoder.onnx
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/onnx/decoder_model_q4.onnx \
  --output apps/cli/dist/models/texteller/decoder.onnx
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/tokenizer.json \
  --output apps/cli/dist/models/texteller/tokenizer.json
```

Verify SHA-256 before using or redistributing the files:

| File | SHA-256 |
| --- | --- |
| `encoder.onnx` | `de5fe45294a00f45af907b783f3f4764dbdc95386676f4e20175d912cfe8e59a` |
| `decoder.onnx` | `d937474a36f212cd704acc811b9eef32405f3aa20c5da812d7bf227abbc6004b` |
| `tokenizer.json` | `ec4ca954798a092faf6fefcfa47fb5f85d76cdf6ab170b624ae1a683d53dae14` |

```sh
pnpm cli document.pdf --formula-model-dir apps/cli/dist/models/texteller \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

Both model types enable native rasterization automatically. Layout is enabled
by default; use `--no-layout` with formula options to run OCR without Heron.
TexTeller adds approximately 245 MiB of assets and preserves the shared
candidate/crop/token limits and strict TeX validation.

### Automatic GPU selection

`--execution-provider auto` is the default: prefer bundled CoreML on macOS,
otherwise WebGPU, then CPU. If GPU model initialization fails, the CLI emits
the reason and retries on CPU. Provider selection is printed to stderr; a
bundled GPU backend alone does not prove compatible hardware exists.

Force a provider when automatic fallback is not desired:

```sh
pnpm cli document.pdf --execution-provider webgpu \
  --layout-model apps/cli/dist/models/heron_fp32.onnx \
  --formula-model-dir apps/cli/dist/models/texteller --format epub
pnpm cli document.pdf --execution-provider coreml \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

No model path is needed with the default layout mode. Both models use the
selected provider. A provider missing from the supplied native runtime is an
error for an explicit choice, not a silent switch to CPU. `--execution-provider cpu`
forces portable CPU inference. Unsupported graph operators still execute on
the CPU, so choosing a GPU provider does not guarantee an entirely GPU workload.

CoreML is macOS-only and uses **MLProgram, static-shape graph partitions, and
CPU/GPU compute units**. Restricting partitions to static shapes avoids CoreML's
invalid shape predictions on Heron's dynamic graph and TexTeller's variable
decoder length. Some partitions remain on the CPU; this mode does not request
the Apple Neural Engine.

Native WebGPU uses Metal on macOS, Vulkan on Linux, and a supported native GPU
backend on Windows. It requires a compatible GPU/driver and a runtime built
with the provider. Full validation remains enabled to detect GPU validation errors.
Model sessions are awaited and released in reverse creation order before exit.
Repeated compiled runs with this lifecycle and validation configuration no
longer reproduced the previous shared-device shutdown failure.

Combined Heron/TexTeller conversion, repeated compiled-process exits, and
provider profiling were verified on Apple Silicon macOS with Bun 1.3.11 and
ONNX Runtime 1.29.0. Profiles contained CoreML/WebGPU execution nodes, not just
CPU fallback. Other platforms' hardware/driver combinations need their own
native smoke checks. GPU floating-point results and OCR can differ slightly
from CPU output; the SPA's independent browser GPU path is unchanged.

The pinned PDF.js dependency is patched to skip optional Node canvas discovery
when `DOMMatrix`, `Path2D`, and `ImageData` are already installed by the native
adapter. This avoids the misleading canvas-load warning inside compiled Bun
without filtering logs. Missing required native libraries still cause an
explicit CLI error naming the resolved runtime directory. Basic, model-free
conversion without native polyfills retains PDF.js's original diagnostics.

## Verification

```sh
pnpm exec vitest run apps/cli/src
pnpm cli:build
bun apps/cli/scripts/smoke.ts apps/cli/dist/bun-darwin-arm64/wordconvert
```

Set `WORDCONVERT_CLI_HERON_MODEL` to the local FP32 model and
`WORDCONVERT_TEXTELLER_MODEL_DIR` to the local TexTeller directory to enable
real-model tests. Set `WORDCONVERT_CLI_EXECUTION_PROVIDER` to `cpu`, `coreml`, or
`webgpu` for those tests and the compiled smoke script. With model paths set,
the smoke script performs three complete conversions in separate processes
and checks clean exit as well as actual Markdown output, catching shutdown
crashes that in-process tests would miss.

The CLI reuses preprocessing, decoding, tokenization, and
resource limits with the SPA; native rendering can differ in pixels and font
metrics between operating systems. See [hardening](hardening.md) for boundaries
and the existing [formula benchmarks](formula-benchmarks/README.md) for OCR
limitations.
