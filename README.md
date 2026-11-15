# WordConvert

WordConvert is a privacy-preserving, local document conversion
workspace. It accepts local DOCX and PDF files plus remote HTML, Markdown,
plain-text, and PDF documents, including arXiv links. Document processing stays
on the device and uses a typed neutral document model.

The static site is also an installable progressive web app. After one successful
load, its application shell, including PDF.js, is cached for offline use;
document conversion and
downloads continue to run entirely on the device.

It accepts unencrypted `.docx` and text-native `.pdf` files and produces
standalone HTML, an HTML ZIP, single-file Markdown, a Markdown ZIP, or a
reflowable EPUB 3 publication. HTTPS URLs may point to HTML, XHTML, Markdown,
plain text, or PDF content. Legacy `.doc`, encrypted documents, and
macro-enabled `.docm` files are rejected.

## Local CLI

The CLI reuses the same semantic DOCX/PDF readers and HTML, Markdown, and EPUB
writers. It also accepts local Markdown and HTML/XHTML for EPUB or other output
formats, preserving semantic structure and bounded relative raster images.
`--include-external-images` optionally embeds public HTTPS raster images in
Markdown/HTML; private networks remain blocked and `--offline` forbids downloads.
Text imports need no native runtime or model downloads. It accepts local files
and processes documents on-device. PDF conversion
defaults to native rendering, Heron layout analysis, and automatic GPU selection
(CoreML on macOS, otherwise WebGPU when bundled, with reported CPU fallback).
Missing models are downloaded once with a warning and cached; `--offline`
prohibits downloads, `--no-layout` enables basic PDF conversion, and
`--clear-model-cache` removes cached models. Formula OCR is optional via
`--formula-ocr`. Missing document language defaults to English.
Output defaults to EPUB, or is inferred from a recognized `--output` extension;
an explicit `--format` takes precedence. EPUB output downscales JPEG, PNG, and
WebP images larger than 1600 px on the longest edge (to keep website
conversions small); use `--max-image-size <px>` to change the limit or `0` to
embed original images. Opaque images are encoded as JPEG at quality **80** by
default, even if already below the dimension limit; transparent images retain
lossless PNG. Only smaller encodings are used. Override with
`--image-format preserve` or `--image-quality <1-100>` (EPUB only).
Pixel dimensions, not DPI metadata, determine the reading resolution.
Use `--cover <image>` to embed a local JPEG, PNG, WebP, or sanitized SVG cover
image in EPUB output. For PDF input whose first page is the cover,
`--frontpage-cover` renders it as the cover and omits that page's images from
the body. Front-page cover rendering requires the native runtime, including
when PDF layout analysis is disabled.

Set publication metadata in batch conversions with `--title`, `--title-sort`,
`--subtitle`, repeatable `--author` and `--subject`, `--author-sort`,
`--language`, `--publisher`, `--description`, `--book-version`, `--rights`,
`--identifier`, `--source-created-at`, `--source-modified-at`, `--pubdate`,
`--isbn`, `--series`, `--series-index`, repeatable `--contributor`,
`--book-producer`, and `--metadata <file>`. `--conversion-date` remains the
reproducible conversion/package-modified date. ISBN checksums warn by default;
`--strict-isbn` turns them into errors. Explicit CLI values override sidecar
values, which override reader inference and filename-derived defaults. The
versioned, 32 KiB-limited JSON sidecar schema and field validation are documented
in the [publication metadata CLI guide](documentation/cli.md#publication-metadata).

```sh
wordconvert book.pdf --cover downloaded-cover.jpg -o book.epub
wordconvert scan.pdf --frontpage-cover -o scan.epub
```

Existing EPUBs can also be shrunk without rebuilding their chapters, navigation,
styles, or metadata:

```sh
wordconvert large.epub                 # Writes large.shrunk.epub
wordconvert large.epub --max-image-size 1200 --image-quality 70 -o compact.epub
wordconvert large.epub --split-chapters -o chapters.epub
```

EPUB input is optimization-only (not conversion to other formats), accepts up to
256 MiB with bounded ZIP expansion, requires the native canvas runtime for image
optimization, and never overwrites the source. Encrypted, font-obfuscated, and
signed EPUBs are rejected. Image filenames, MIME types, and book references
are updated together. Existing TOCs are preserved; a missing TOC is generated
from headings (or existing spine documents). `--split-chapters` optionally
organizes XHTML into one file per detected chapter; otherwise existing chapter
files stay intact.

PDF imports automatically remove high-confidence repeated page numbers, running
headers, and footers. EPUB shrinking removes page numbers and repeated running
matter only when explicit page-break markers support that classification.
Text baked into images remains.

PDF tables become table blocks when the source declares them (`tagged`) or their
cell borders close into a grid (`ruled`). `--pdf-tables` selects which of those
signals the reader may act on, accepts `none` to keep tables as paragraphs, and
can opt into `borderless`, which infers a table from aligned columns alone and
stays off by default. A table that cannot be resolved stays paragraphs.

PDF text reflow also exposes `--unwrap-factor <0..1>` (default `0.45`) for
short-line handling and opt-in `--dehyphenate on` for evidence-based word joins.
The reader reports suspicious multi-column ordering for review rather than
treating the PDF text layer as authoritative. See [the CLI guide](documentation/cli.md#pdf-text-reflow).

Semantic text normalization decodes ligatures by default and conservatively
detects scene breaks; punctuation smartening is opt-in with
`--smarten-punctuation` (or `--unsmarten-punctuation`). Scene-break markers,
blank-paragraph cleanup, and ligature retention are configurable. These
transforms preserve code, URLs, equations, and assets and report deterministic
counts. See [the CLI guide](documentation/cli.md#text-normalization).

For exceptional source cleanup, `--search-replace <file>` applies bounded,
ordered UTF-8 regex/replacement pairs to inline text. PDF-only
`--header-regex` and `--footer-regex` create reviewable furniture candidates;
only repeated high-confidence matches are removed automatically. See the
[pattern-rule limits and file format](documentation/cli.md#text-normalization)
and [PDF furniture options](documentation/cli.md#pdf-page-numbers-running-headers-and-footers).

PDF chapter detection defaults to `automatic`: repeated, short, spaced body-style
openers matching chapter/book/section/prologue/epilogue/part are promoted to
headings only when paragraph segmentation is trustworthy. Explicit style mappings
take precedence; uncertain candidates are reported rather than silently promoted.
Use `--chapter-detection off|automatic|custom`, `--chapter-split-level 1-6`
(default `2`), and `--chapter-mark pagebreak|rule|none|both` (default `none`).
Consecutive same-level heading blocks are merged into one title while retaining
inline formatting, numbering, and the first block's ID. EPUB marks chapters at
file boundaries; HTML uses page-break/rule elements and Markdown uses a page-break
comment/rule. Chapter markers are inserted only between top-level content blocks.
See [the CLI guide](documentation/cli.md#chapter-detection-and-marking).

PDF TOCs prefer resolved bookmarks, then semantic headings, with printed-contents
and internal-link fallback when fewer than six chapters are detected. Configure
the source with `--toc-source automatic|embedded|generated|off`; use
`--toc-threshold`, `--max-toc-links`, `--duplicate-links-in-toc`, and
`--toc-filter` to tune fallback behavior. `--toc-inline`, `--toc-title`, and
`--toc-at-end` control the visible contents section/page in generated HTML,
Markdown, and EPUB. See [the CLI guide](documentation/cli.md#pdf-tables-of-contents)
for precedence and compatibility flags.

The CLI also exposes PDF extraction controls: `--crop-top <0..1>` and
`--crop-bottom <0..1>` trim rotated-page text (their sum must stay below `0.9`);
`--no-remove-furniture` retains automatic header/footer/page-number candidates;
repeat `--remove-furniture <id>` or `--keep-furniture <id>` to apply reviewed
decisions, and `--list-furniture` prints candidate IDs and their evidence.
`--no-images` skips PDF image extraction, including figure and rendered-equation
images, and requires `--no-layout`. These are PDF-only options; existing EPUB
shrinking behavior is unchanged. See [the CLI guide](documentation/cli.md#pdf-page-numbers-running-headers-and-footers).

Use repeatable `--verbose` (up to twice) for stage timings and object counts,
then applied options and inference provider/model details. `--debug-pipeline
<dir>` also enables stage timings and writes a versioned request, PDF raw and
analysis data, the final semantic model, and pre-packaged writer text files.
The DOCX reader and existing-EPUB shrinker identify unavailable semantic stages
explicitly. Dumps contain document text, are created in a new private directory,
and omit asset bytes in favor of size/SHA-256 references by default. Use
`--debug-pipeline-assets` to include exact stage-4 writer artifacts, including
embedded base64 data URLs. Keep dumps private;
`--force` is required for a dump directory outside the current working directory
and never permits using the input directory or one of its ancestors.

With [Bun 1.3.11](https://bun.sh/) installed for development:

```sh
pnpm install --frozen-lockfile
pnpm cli document.docx --format epub --output document.epub
pnpm cli:build
pnpm cli:install
```

The build creates `apps/cli/dist/<target>/wordconvert` (`wordconvert.exe` on
Windows). The executable does not require Bun or Node on the destination
machine. Keep its `runtime/` folder alongside it for optional PDF rendering and
model inference; DOCX and basic PDF conversion (`--no-layout`) can use the executable alone.
Native bundles are built on their destination OS/architecture, and the CLI
workflow publishes macOS, Linux, and Windows build artifacts, and `cli-v*`
tags publish all five portable bundles with checksums as GitHub releases.
`pnpm cli:install` copies the local bundle and creates a PATH symlink on Unix;
use `pnpm cli:install -- --force` to upgrade a script-managed installation.

See [CLI usage and optional models](documentation/cli.md) for installation,
cross-compilation, presets, deterministic output, model setup, and limitations.

### Agent skill: fetch-to-epub

The optional [fetch-to-epub skill](skills/fetch-to-epub/SKILL.md) guides an agent
through downloading authorized web articles or PDFs, converting them with
`wordconvert`, and checking EPUB completeness and image size. It also documents
privacy precautions for browser captures and shrinking existing EPUB files.

Copy `skills/fetch-to-epub/` into your agent's supported skills directory
(for example, `~/.agents/skills/`), then invoke `fetch-to-epub` explicitly.
Install `wordconvert` separately; browser-assisted capture also requires the
`browser-tools` scripts and `BROWSER_TOOLS_DIR` as described in the skill.
Those scripts are not bundled here.

## Browser workflow

The Mithril SPA presents the conversion workflow from document selection
through download in a responsive, keyboard-accessible light/dark shell. The
file picker and drag-and-drop target accept `.docx` and `.pdf` input, and the
interface states clearly that source content is processed only in memory on the
current device. A URL field downloads supported remote documents directly in
the browser without a proxy, credentials, or a referrer. Local storage is
limited to theme/output preferences and style-mapping presets.

The security defaults cap DOCX input at 50 MiB compressed, 200 MiB expanded,
1,000 ZIP entries, a 100:1 per-entry compression ratio, and 25 MiB per image.
PDF input is capped at 50 MiB, 2,000 pages, 2,000,000 text items, and 40
megapixels per extracted image. Hosts may override these typed reader limits
deliberately. See [hardening and browser verification](documentation/hardening.md)
for the threat-to-test matrix, performance budget, compatibility policy, and
interactive evidence.

Analysis and output generation run in a Web Worker through a typed protocol with transferable input/output buffers, progress messages, cancellation, private structured errors, and per-operation cleanup. The worker delegates directly to the reader and output writers; it contains no conversion logic. Output settings cover standalone or packaged HTML, single-file or packaged Markdown, EPUB, embedded or generated-folder assets, formula rendering, and optional EPUB covers. Every setting can be changed and rerun without re-uploading the source; generated object URLs and output buffers are released immediately after download.

HTML and rendered Markdown previews pass through DOMPurify with active elements, inline styling, remote URLs, and unknown protocols blocked. EPUB previews expose the generated package structure and passive contents. Conversion warnings link back to the relevant style, metadata, formula, asset, or output setting.

The style review table exposes each proposal, confidence, evidence, examples, effective formatting, and every semantic mapping. Mappings can be edited individually, accepted in bulk when confidence is high, and applied by rerunning analysis. Versioned JSON presets can be validated, imported, exported as plain text, and saved locally; invalid schema versions and mapping values are rejected.

The metadata review stage covers title, subtitle, structured authors, language, publisher, description, subjects, version, source creation and modification dates, publication and conversion dates, identifier, and rights. Each value shows its provenance, confidence, and extracted, inferred, default, or user-edited status. Editor state remains in memory while moving between workflow stages.

## Remote and arXiv import

WordConvert can open HTTPS documents directly from a URL. arXiv abstract, PDF,
and HTML links are normalized to arXiv's source-derived HTML representation when
available, preserving semantic headings, authors, abstracts, links, figures,
lists, and LaTeXML equations more faithfully than reconstructing them from PDF
geometry. Imported article images are fetched only from the same origin and are
subject to bounded count and byte limits; inaccessible images retain their
alternative text.

Remote HTML is parsed inertly and sanitized before preview or output. Safe
source structure and bounded CSS are retained for HTML and EPUB conversion, and
the XHTML can be edited beside a sandboxed live preview. Markdown and plain-text
documents enter the same semantic output workflow. Remote hosts must permit
browser access through CORS; WordConvert does not proxy around that policy or
persist downloaded source content.

## Style and metadata analysis

`@wordconvert/docx-reader` separates OOXML extraction from analysis and final model construction. `analyseStyles` reports every used paragraph and character style with inherited effective formatting, usage samples, a proposed semantic mapping, confidence, and reasons. Heading evidence follows the documented precedence; font size is never sufficient by itself.

Word heading styles remain semantic headings even when Word numbering is
attached to them, rather than being misclassified as list items. Multilevel
decimal, alphabetic, and Roman numbering is reconstructed from OOXML numbering
definitions and retained in HTML, Markdown, and EPUB output. Caption inference
also requires consistent figure or table adjacency, avoiding false captions
when an ordinary body style is reused near a single object.

`@wordconvert/pdf-reader` similarly separates PDF.js extraction, layout
analysis, user cleanup choices, and final model construction. It preserves
rotated page-relative text geometry, links, raster images, metadata, outlines,
and tagged structure, then reconstructs one- or two-column reading order.
Configurable top and bottom crop regions provide predictable page-furniture
removal. Repeated odd/even headers, footers, and variable page numbers are
proposed separately; only high-confidence repetition is removed automatically,
and every candidate remains reviewable.

Callers can pass `stylePreset` and `styleMappings` to `DocxReaderOptions`. Explicit mappings take precedence over presets and inferred evidence, making reruns deterministic. `resolveMetadataCandidates` selects metadata by source priority while retaining provenance and confidence, structured authors, and separate source, publication, and conversion dates.

## HTML output

`@wordconvert/html-writer` exposes `writeHtml` for deterministic standalone HTML or a preview fragment, and `writeHtmlZip` for an editable package containing `document.html`, `styles.css`, and generated `images/` and `fonts/` paths. The serializer covers every document-model node, builds a heading table of contents, embeds standalone assets, and emits script-free offline output with print and reader light/dark styles.

The writer escapes document content and metadata, accepts only safe link schemes and passive image/font media, and never trusts source asset filenames. Browser callers must still apply DOMPurify before inserting preview fragments into the DOM.

## Markdown output

`@wordconvert/markdown-writer` exposes `writeMarkdown` for a single Markdown file with embedded data-URI images and `writeMarkdownZip` for an editable package containing `document.md` and generated `images/` paths. The semantic serializer supports headings, formatting, safe links, nested lists, blockquotes, fenced code, GFM tables, footnotes, passive images and captions, and inline or block math.

Both modes are deterministic. ZIP asset names are generated rather than copied from source filenames, and callers can use the typed `onWarning` callback to surface omitted unsafe links, unsupported media or styles, missing references, and table-span degradation.

## EPUB output

`@wordconvert/epub-writer` exposes `writeEpub` for deterministic, reflowable EPUB 3 output. It writes the stored `mimetype` entry first, then the container, package metadata, navigation document, title page, H1-based XHTML chapters, local stylesheet, and generated passive image/font assets with a complete manifest and spine.

Required identifier, title, language, and EPUB modification time can come from the document model or typed writer overrides. ZIP entries use a fixed 1980 timestamp and stable order for byte-identical output; the independently injected `dcterms:modified` value records the publication modification time required by EPUB 3. The writer omits remote links, active media, SVG, scripts, event handlers, iframes, unsafe URLs, and unsupported resources. Install `epubcheck` to enable the focused local conformance test.

## EPUB covers

`@wordconvert/cover-generator` creates deterministic, browser-independent SVG compositions for image-only, overlay, title-panel, separate-title-page, and generated typographic covers. It accepts bounded JPEG, PNG, WebP, and sanitized SVG inputs, uses only system-safe font families, and exposes rasterization through an injected adapter for browser-only compatibility paths.

The EPUB editor can omit a cover, upload an image, choose a supported extracted document image, or generate a typographic cover. The CLI accepts a local image with `--cover`, or can use a PDF's first page with `--frontpage-cover` and omit that page's image from the body. The editor's live preview exposes crop, alignment, title and author positions and sizes, text colour, contrast panel and opacity, image opacity, safe margins, and aspect ratio. A conservative filename heuristic explains when an image may already contain title text. Generated EPUBs declare the cover image and cover page while always retaining a separate semantic XHTML title page.

## Formula output

`@wordconvert/math-converter` converts a safe OMML subset into a normalized math tree and independent TeX and MathML serializations. The supported subset covers inline and display equations, fractions, roots, matrices, subscripts, superscripts, and Unicode mathematical symbols. Unsupported or malformed OMML retains bounded diagnostic text and produces a `formula-conversion-incomplete` warning.

HTML, Markdown, EPUB, and browser previews support source fallback, accessible MathML, pre-rendered KaTeX, and disabled formula modes. KaTeX runs with strict errors and `trust: false`; its CSS and font are embedded locally without network requests. EPUB defaults to MathML for accessibility and compatibility. Formula conversion is intentionally incomplete for uncommon OMML constructs, which use the source fallback rather than being silently discarded.

## Known conversion limitations

WordConvert preserves semantic document structure rather than Word's paginated
layout. Page breaks, exact line wrapping, floating shapes, text boxes, columns,
watermarks, and desktop-font metrics may therefore differ or be omitted. Headers,
footers, comments, and tracked deletions are inspected but omitted from the main
content with a warning. Complex table spans, uncommon list definitions, active
SVG, unsafe links, unsupported image formats, and uncommon OMML constructs may be
degraded or replaced by a safe fallback. Always review the preview and warnings
before publishing.

PDF conversion reconstructs semantics from positioned drawing instructions.
Tagged PDFs provide the strongest structure; untagged one- and two-column books
and articles use deterministic geometry and typography heuristics. Complicated
tables, sidebars, overlapping text, and irregular multi-column layouts may need
manual review. Image-only pages are preserved as images and produce an explicit
warning because full-page text OCR is not yet included. Formula OCR is supported
separately for bounded equation regions.

Heading proposals combine OOXML outline levels, stable Word style IDs, document
structure, localized aliases, inheritance, typography, and usage patterns; font
size alone never creates a heading. The style-review stage shows confidence and
evidence and lets the user override every mapping. Metadata is similarly inferred
from document properties, semantic styles, first-page structure, and the filename.
Its provenance and confidence remain visible, and publication, source, and
conversion dates remain separate.

Cover creation supports a safe uploaded or extracted image, deterministic
typographic SVG, image/text overlays, or no cover. SVG is sanitized, remote fonts
are forbidden, and every EPUB retains a semantic XHTML title page. Browser-side
rasterization is adapter-driven and may vary slightly between rendering engines.

## Privacy and security

Conversion runs locally in a Web Worker. WordConvert has no analytics and does not
send document bytes, text, metadata, filenames, images, or diagnostics over the
network. Source data and generated output stay in memory; local storage contains
only preferences, validated style presets, and dense-PDF-page choices the user
asked to remember, keyed by a SHA-256 fingerprint of the file. A static host can
serve the app without a conversion service.

PDF pages with dense vector illustrations, such as detailed infographics, are
detected during full conversion. WordConvert asks once per document whether to
keep them as page images with their prose, all their text, or no text, or to
convert them like other pages. A per-page time limit falls back to a page image
or page text instead of stalling.

Full PDF conversion uses the bundled Docling Heron layout model to identify
pictures and tables before combining those proposals with PDF.js image, vector,
text, and caption evidence. The FP16 ONNX model and its WebGPU/WASM runtime are
same-origin assets cached with the application for offline use. Sample cleanup
analysis remains model-free. Regenerate the pinned model with
`uv run --python 3.12 scripts/export-heron-onnx.py` and validate the browser
runtime with `pnpm test:heron`.

PDF formulas are first detected and reconstructed from local PDF geometry and
text. Complex candidates that cannot be reconstructed reliably use a separately
lazy-loaded TexTeller q4 ONNX model. Its approximately 245 MiB of same-origin
assets are downloaded and cached on first use, with WebGPU preferred and a
single-threaded WASM fallback; complex documents therefore take longer to
convert. Formula recognition can be disabled and its cache can be cleared from
the home screen. Formula crops and inference remain inside the conversion
worker. Check local real ONNX graphs with
`WORDCONVERT_TEXTELLER_MODEL_DIR=/path/to/texteller-q4 pnpm test:formula-ocr`.
Manual page-bounded formula regions use the same local
recognition, review, cancellation, and resource-limit path; source pixels and
recognized TeX are never sent to a service. The Formula Review stage shows
validated KaTeX, confidence and diagnostics, and lets users keep reconstructed
or recognized TeX, treat a candidate as text, retain its source image, adjust
its crop, or draw a new region. Recognition failures preserve source content
rather than silently replacing it. See the
[formula benchmark](documentation/formula-benchmarks/README.md) for the measured
accuracy, timing, transfer, memory, and alternative-model decision.

The default DOCX reader limits are 50 MiB compressed input, 200 MiB expanded
content, 1,000 ZIP entries, a 100:1 per-entry compression ratio, and 25 MiB per
image. PDF limits are 50 MiB input, 2,000 pages, 2,000,000 text items, and 40
megapixels per extracted image.
Formula analysis is capped at 100 candidates per page, 1,000 per document,
4 megapixels per crop, 40 megapixels of total temporary crops, and 512 decoder
tokens per formula.
Unsafe XML, paths, links, HTML, SVG, and remote resources are rejected or
sanitized. Raising these typed limits increases memory exposure. See the
[hardening checklist](documentation/hardening.md) for the complete threat matrix,
browser support policy, performance budget, and known manual release gates.

## Development and testing

WordConvert requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server opens the Vite SPA at the printed local URL. Run the full
repository quality gates before submitting a change:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Regenerate the synthetic DOCX corpus with `pnpm fixtures:generate` and the PDF
corpus with `pnpm fixtures:pdf`, then confirm
that `git diff --exit-code -- tests/fixtures/docx` is empty. See
[fixture documentation](tests/fixtures/docx/README.md) for its deterministic
manifest and generated-in-memory security cases.

Interactive browser verification uses the standard comprehensive fixture and the
eight-stage checklist in [hardening and browser verification](documentation/hardening.md).
The current and previous major Chrome, Edge, Firefox, and Safari releases are the
support target; Chromium is automated/recorded, while direct Firefox and Safari
runs remain a human release gate.

Install the `epubcheck` executable and ensure it is on `PATH`, then run:

```sh
pnpm exec vitest run packages/epub-writer/src/index.test.ts
```

The focused suite detects EPUBCheck automatically and runs its conformance case;
without the executable that case is explicitly skipped. A successful validation
reports no EPUB errors or warnings.

More contributor detail, including exact fixture, browser, EPUBCheck, and build
commands, is in [tooling](documentation/tooling.md). The stable model,
reader/writer contracts, privacy boundaries, security limits, and future
Rust/WASM adapter path are documented in [core contracts](documentation/core-contracts.md).

## GitHub Pages deployment

Production builds default to the `/word-convert/` base path. For another repository
name, include both slashes when overriding it:

```sh
WORDCONVERT_BASE_PATH=/my-repository/ pnpm build
```

The `Verify and deploy WordConvert` workflow builds `apps/web/dist` on pushes to
`main` and deploys it with GitHub's Pages actions. Pull requests run the same
frozen install, formatting, lint, strict type, test, EPUBCheck, production build,
and static/offline-output checks without deployment permissions. In repository
settings, select **GitHub Actions** as the Pages source, then run the workflow or
push to `main`. The deployment is static; it requires no secrets or conversion
backend.

## Future Rust/WASM reader

The browser-independent `DocxReader` interface accepts exact `Uint8Array` input
and explicit JSON-safe options and returns the versioned, serializable
`DocumentModel`. A future `WasmDocxReader` can implement that boundary while the
TypeScript writers, worker protocol, and UI remain unchanged. The current plan is
to move parsing only when representative fixtures show a measurable benefit, not
to rewrite output generation prematurely.

## Licence and attribution

WordConvert is released under the [MIT License](LICENSE). Reviewed runtime
dependency licences and copyright notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Re-run the documented licence
audit whenever `pnpm-lock.yaml` changes.
