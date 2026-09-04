# Hardening and browser verification

This document is the release checklist for security, privacy, performance, and browser compatibility. The automated checks are the source of truth; the interactive evidence records exploratory runs performed on 16 July and 2 September 2026.

## Security requirement-to-test matrix

| Requirement | Limit or policy | Regression coverage |
| --- | --- | --- |
| ZIP bombs and extreme compression ratios | `maxCompressionRatio: 100` | `docx-reader/src/index.test.ts` hostile `compression-ratio.docx` fixture |
| Excessive package size | `maxCompressedBytes: 50 MiB`, `maxUncompressedBytes: 200 MiB` | Configurable compressed/expanded-size assertions in `docx-reader/src/index.test.ts` |
| Excessive entry count | `maxEntries: 1,000` | Generated entry-count fixture in `docx-reader/src/index.test.ts` |
| Path traversal and malformed/encrypted ZIPs | Reject before extraction | Hostile fixtures and encrypted-entry assertions in `docx-reader/src/index.test.ts` |
| Malformed XML and entity expansion | Reject unsafe XML | Malformed and `xml-entity-expansion.docx` fixtures in `docx-reader/src/index.test.ts` |
| Unsafe hyperlinks and remote resources | Allow local/passive resources and safe schemes only | Reader hostile fixture; HTML, Markdown, EPUB writer tests; preview DOMPurify policy test |
| Active SVG and unsafe HTML | Quarantine scripts, handlers, remote references, CSS imports, and processing instructions | Parameterized SVG tests, writer tests, cover-generator sanitization test, and preview policy test |
| Unexpectedly large images | `maxImageBytes: 25 MiB` per image | Configurable oversized-image assertion in `docx-reader/src/index.test.ts` |
| Memory exhaustion | Bound package, expanded content, entry count, compression ratio, and each image; transfer output buffers and release them after download | Reader limit tests, worker runtime cleanup tests, and download lifecycle tests |
| Script injection through metadata, formulas, or filenames | Escape semantic text and generate safe output paths | HTML/Markdown/EPUB writer hostile-input tests, math-converter injection test, cover-generator escaping test |
| Active markup entered in the EPUB content editor | Parse Markdown tokens into typed document blocks; preserve raw HTML as escaped text and reconnect only exact existing asset data URIs | Content-editor parser tests and restrictive preview DOMPurify policy |
| Failure and cancellation cleanup | Remove every operation in `finally`; stale cancellation creates no retained state | Worker runtime cancellation and actual reader-failure tests assert zero active operations and private errors |
| Sensitive-data disclosure | No document logging, analytics, conversion fetches, URL parameters, or document persistence | Worker test spies on console and `fetch`; state tests restrict storage to preferences and validated mapping presets |
| Excessive PDF input | `maxInputBytes: 50 MiB`, `maxPages: 2,000`, `maxTextItems: 2,000,000`, and `maxTextItemsPerPage: 100,000` | PDF reader corpus and configurable-limit tests |
| Excessive PDF raster images | `maxImagePixels: 40,000,000` per image, `maxImages: 10,000`, and `maxTotalImagePixels: 80,000,000` across placements | PDF reader configurable per-image and aggregate-limit tests |
| PDF vector figure rendering | Detect connected path regions, render only bounded regions to passive PNG, and charge them to the existing image-count and pixel budgets | PDF reader figure-region and aggregate-limit tests; browser conversion check |
| PDF layout model | Run the bundled Apache-2.0 Heron FP16 ONNX model on fixed 640×640 local page renders; accept only bounded, confident picture/table proposals and retain deterministic geometry fallback | Heron preprocessing/decoding tests and PDF proposal-fusion tests |
| PDF formula recognition | At most 100 candidates per page and 1,000 per document; 4 MP per temporary crop, 40 MP total, and 512 decoder tokens; strict safe KaTeX validation; preserve source on every failure | Formula candidate, real-crop, fake-session adapter, cancellation, and opt-in real-model tests |
| Remote document import | HTTPS only, omit credentials/referrer, enforce 50 MiB while streaming, validate HTML/Markdown/text/PDF response types, parse HTML inertly, and keep URL/bytes out of persistence | Remote document normalization, classification, limit, semantic-import, and failure tests |
| Encrypted or malformed PDF | Reject before semantic analysis with private structured errors | Password-protected and malformed PDF corpus fixtures |
| PDF external loading | Supply exact bytes; disable range, streaming, auto-fetch, system-font, and external WASM loading | Worker privacy regression spies on `fetch` during DOCX and PDF analysis |
| False-positive page-furniture removal | Crop bounds are explicit; repeated content is parity/position aware; medium/low confidence remains until user review | PDF layout tests cover crop boundaries, short documents, odd/even headers, and explicit candidate overrides |

All reader limits are configurable through `DocxReaderOptions.limits`. Raising them increases peak memory exposure and should be a deliberate host-application decision.

PDF limits are configurable through `PdfReaderOptions.limits`. The application
conversion worker launches the bundled PDF.js module worker; conversion does not
load optional CMaps, standard fonts, image decoders, or WASM from remote URLs.

## Determinism and performance budget

The representative `standard-comprehensive.docx` fixture is parsed twice and both `DocumentModel` values must be deeply equal. The two reads share a 1,000 ms regression budget in Vitest. The 16 July 2026 local run completed the pair in approximately 2 ms; the generous CI threshold is intended to catch large regressions without making shared runners flaky. Writer suites separately assert byte-identical deterministic HTML, Markdown ZIP, EPUB, and cover output.

The synthetic PDF corpus covers one- and two-column text, tagged structure,
links, raster images, odd/even running headers, page-number footers, image-only
pages, password protection, and malformed input. Repeated PDF reads must produce
deeply equal analysis and `DocumentModel` values.

## Browser support policy

WordConvert targets the current and immediately previous major releases of Chrome, Edge, Firefox, and Safari on desktop, plus the corresponding current mobile engines. The production build targets ES2022 and relies on standards available in those releases: Web Workers, transferable `ArrayBuffer`, `Blob`, `File`, object URLs, structured cloning, HTML canvas, CSS Grid/Flexbox, and module scripts. Browsers exposing the File System Access API use their native save picker so the user can choose the output filename and folder. Other browsers retain the generated filename and use the standard browser download flow.

Workflow URLs use the History API under the configured application base path.
The static build emits `404.html` from the same application shell so GitHub
Pages can load document, output-format, Markdown, HTML, and EPUB routes before
the client normalizes them. Conversion routes require the source document to
remain in memory; opening one in a fresh browser context returns to document
selection rather than persisting or reconstructing source data.

Completed EPUB output can be handed to an installed mail client through the Web Share API when the browser reports file-sharing support. The EPUB remains in memory until this explicit user action and is passed as a `File` with the document title as the share title; no recipient, message body, URL, or remote service is supplied. Browsers without file-sharing support open an empty `mailto:` draft with only the encoded subject. The `mailto:` standard cannot attach local files, so attaching the EPUB in that fallback remains a manual mail-client action.

PDF source-page previews are loaded only on request and rasterized on an HTML canvas with a maximum width of 1,200 pixels and a 4-megapixel budget. The browser-canvas path supports embedded fonts that PDF.js cannot reliably draw on `OffscreenCanvas` for some legacy PDFs. Preview rendering is best-effort so recoverable legacy-font errors do not produce blank pages; extraction remains strict. Preview tasks and PNG object URLs are released when replaced, when another source is selected, and when the page unloads.

Initial PDF cleanup analysis reads five deterministic representative pages by default, without extracting images. The user can increase and rescan that sample before the first full-document pass. Output choices remain unavailable until cleanup is applied to the complete document. Crop bands omit text only; images are retained even when they overlap a configured band.

During the full-document pass, connected clusters of PDF vector paths and substantial embedded images seed bounded figure regions that PDF.js renders to passive PNG assets inside the conversion worker. Image-seeded renders preserve the effective source-image resolution up to the configured pixel budget, include overlaid PDF labels or drawing commands, and suppress duplicate text inside the rendered region. Tiny icons remain independent assets. Figure surfaces are capped by the existing per-image and aggregate pixel budgets and are released immediately after PNG encoding. This deliberately favors ebook fidelity and passive output over exporting active SVG or fragmented text assembled from untrusted PDF drawing commands.

Full PDF conversion also renders each page to a fixed 640×640 RGBA surface and
runs the bundled Docling Heron model through ONNX Runtime Web in the conversion
worker. WebGPU is preferred when available, with a single-threaded WASM fallback.
Picture and table predictions with at least 0.6 confidence seed figure
composition; coordinates are clipped to the page and remain subject to the
existing image and pixel budgets. Confidence-ordered overlap suppression keeps
the strongest learned proposal where picture and table predictions duplicate
the same visual region. Learned regions take precedence over overlapping
deterministic image, vector, and caption regions so heuristic geometry cannot
widen them into surrounding prose. Learned crops preserve the detected bounds
without adding safety margins, avoiding capture of adjacent text lines.
Deterministic geometry remains the fallback where no accepted learned region
overlaps. Sample cleanup analysis does not execute the model.

Complex formula candidates that deterministic text reconstruction cannot handle
are rendered at up to 3× logical resolution on a white temporary worker canvas.
Crops are page-bounded, charged to configurable per-crop and aggregate pixel
limits, copied to RGBA, and disposed before inference. Pinned TexTeller q4
encoder and autoregressive decoder graphs run with WebGPU preferred and
single-threaded WASM fallback. Decoder generation is capped at 512 tokens and
checks cancellation between steps. Strict safe KaTeX parsing validates output;
detector evidence, decoder diagnostics, parse success, and prose contamination
produce a discrete review band. Failures preserve the source PDF text and add a
reviewable warning.

Formula Review renders validated TeX through KaTeX with `trust: false`, then
passes the generated markup through the shared restrictive DOMPurify policy.
The formula-only policy retains KaTeX's generated inline positioning styles so
fractions, scripts, and aligned rows remain legible; active tags, event handlers,
unknown protocols, and remote resource URLs remain forbidden.

The 60-crop Chromium 146 WebGPU run parsed 48 outputs with no inference failures
and produced 7 normalized exact results. Median inference was 322.0 ms, p95 was
595.8 ms, initialization was 3,024.0 ms, and observed JavaScript heap peaked at
226,651,669 bytes. These results keep recognized output reviewable and retain the
named 3x crop scale, tight page bounds, and current confidence policy. Full
methodology, raw measurements, detector precision/recall/IoU, and the TexTeller
preflight decision are in [formula-benchmarks](formula-benchmarks/README.md).

Manual formula selections are normalized to page-bounded coordinates and enter
the same reader-owned candidate, recognition, warning, and decision pipeline.
Stable coordinate-derived IDs preserve selections across deterministic reruns;
removing or marking a region as text removes its semantic equation without
retaining a UI-owned node. Pointer selection has percentage-field and keyboard
alternatives.

The two TexTeller q4 graphs and tokenizer total approximately 245 MiB. They are
requested only on the first complex formula during full processing, served as
same-origin assets, and excluded from install-time precaching.
The service worker caches successful same-origin responses after first use.
Ordinary PDFs, deterministic formulas, and representative cleanup scans do not
load the formula model. Users can disable formula recognition and delete only
TexTeller requests from Cache Storage on the home screen.

Standalone equations with fragmented fraction geometry are rendered to tightly
bounded passive PNG assets under the existing image-count and pixel budgets.
Analysis replaces only the covered equation spans with a baseline-aligned
inline image and preserves surrounding prose. Equation candidates are assembled
from connected formula glyphs, exclude adjacent text lines, and are rejected
when they exceed half the page width. Sentence-like lines containing inline
expressions remain PDF.js text. HTML and EPUB retain responsive equation width
classes; Markdown emits an escaped passive `img` element with the same class and
percentage width. Validated equation crops take precedence over overlapping
learned picture/table proposals; learned proposals enclosing sentence-like
prose are rejected so paragraphs are not duplicated as image strips.

The FP16 model is approximately 82.5 MiB and the emitted ONNX WASM runtime is
approximately 25 MiB. Both are same-origin, content-hashed build assets. After
the initial PDF cleanup sample, the application prepares the model and runtime
in the background while the user reviews crop settings. The service worker
caches them after that request rather than downloading approximately 108 MiB
during installation. Model inference therefore makes no third-party request and
remains available offline after its first successful use; users who do not open
PDFs avoid the model download entirely. Preparation removes the one-time download
and session setup from the subsequent full-document wait, but full processing
still classifies every page locally. Per-page inference remains the dominant cost
for long PDFs and should not be presented as part of the one-time setup. This
runtime and cache budget should be re-measured when the model or ONNX Runtime
version changes.

Remote document import downloads only HTTPS resources using CORS with omitted credentials and no referrer. arXiv abstract, HTML, and PDF URLs are normalized locally to the source-derived `/html/` version. Responses are capped at 50 MiB while streaming and must resolve to HTML, XHTML, Markdown, plain text, or a valid `%PDF-` signature. PDF responses enter the existing file-analysis path. Textual responses are parsed on the main thread into the semantic model and bypass PDF extraction and formula recognition.

HTML parsing uses an inert `DOMParser` document, scopes arXiv content and image discovery to its LaTeXML article element, removes active elements, accepts only HTTPS, `mailto:`, and local-fragment links, and converts LaTeXML `math[alttext]` values directly to semantic TeX equations. Page-header, footer, logo, funder, and icon resources are never requested. Up to 100 same-origin HTTPS raster article images are fetched without credentials or a referrer, with 10 MiB per-image and 50 MiB aggregate limits, then registered as model assets; unavailable, cross-origin, unsupported, or oversized images retain only their alternative text. For non-arXiv hosts, up to 20 same-origin linked stylesheets are fetched under the same 15-second deadline and a 2 MiB per-file limit. ArXiv stylesheet requests are skipped because its static CSS endpoints deny cross-origin browser reads. Embedded and fetched CSS is parsed with lazily loaded `css-tree`; imports, namespaces, font faces, URL values, legacy executable properties, and expression functions are removed before the generated rules are added to standalone HTML and EPUB output. A local LaTeXML compatibility sheet preserves document titles, abstracts, author grouping, list labels, intrinsic image dimensions, figures, and equation layout without copying arXiv's stylesheet. Source HTML previews run in sandboxed `srcdoc` frames so sanitized document selectors cannot alter the WordConvert interface, and their foreground/background palette follows the selected application theme. DOMPurify sanitizes retained source markup during import and again after every source edit. A remote host can still reject browser access through CORS, and WordConvert does not proxy around that policy. Remote source content is not persisted.

Completed PDF conversions can show the original source page beside Markdown, HTML, or EPUB output. The source preview remains opt-in, renders one page at a time under the existing 1,200-pixel/4-megapixel preview budget, and stacks above converted output on narrow viewports. Hiding it retains no additional document persistence and releases replaced page object URLs through the existing preview lifecycle.

EPUB content edits for DOCX, PDF, and Markdown sources are parsed from Markdown into a cloned `DocumentModel` before worker conversion. Source-preserved HTML imports instead use a syntax-highlighted XHTML editor with an adjacent live sandboxed preview and remain on the direct XHTML writer path; only exact references to known model assets survive edit sanitization. Edited content remains in memory and is discarded when a new source is selected or analysis is rerun.

The in-app browser run directly verified the Chromium path, which also exercises the engine used by Chrome and Edge. Firefox and Safari were not available in this environment, so direct two-version engine runs remain a release gate rather than a claimed result. No engine-specific API is used in conversion packages; any discovered browser-specific issue should be recorded here with the affected version and workaround.

## Interactive browser evidence

The 2 September 2026 Chromium 146 run used the six-page PDF fixture and verified
that a fully analysed PDF with zero detected equations still exposes Formula
Review. A real pointer drag normalized to `18%, 24%, 40%, 14%`; the percentage
inputs provided the keyboard alternative and clamped edits to page bounds. The
manual candidate survived the full reader rerun and an invalid non-math crop
returned a reviewable recognition warning without aborting conversion. The
selection surface exposed a page-specific accessible name and keyboard focus.
Desktop and 390 CSS px mobile views had no horizontal overflow. Formula and
model requests remained same-origin; no source crop was sent externally.

Screenshots:

- [Desktop manual formula selection](browser-evidence/manual-formula-selection.png)
- [Mobile manual formula review](browser-evidence/mobile-manual-formula-review.png)

The 16 July 2026 in-app Chromium run used the standard comprehensive DOCX fixture and verified:

- file selection through the development-only fixture route, style mapping edits, metadata title edits, formula-bearing content, and navigation across all eight stages;
- standalone and ZIP HTML, single-file and ZIP Markdown, and EPUB generation;
- semantic HTML preview, rendered/source Markdown switching, EPUB package inspection, and a generated typographic EPUB cover;
- all download actions and immediate removal of output buffers/object URLs from application state;
- keyboard activation of the theme control, accessible named form controls and landmarks, light/dark themes, and no horizontal overflow at 398 CSS px or 1,417 CSS px;
- no surfaced application error in the completed workflow and no unexpected external requests. The development fixture request and Vite module requests are expected local-only traffic; the worker privacy regression test independently asserts zero conversion-time fetches and console output.

Screenshots:

- [Mobile document picker](browser-evidence/mobile-document-picker.png)
- [Mobile output-format screen](browser-evidence/mobile-output-formats.png)
- [Desktop document picker](browser-evidence/desktop-document-picker.png)

The UI defines no motion animation or transition that needs a reduced-motion alternative. Light and dark palettes were visually checked for readable text, focus controls, and status contrast. The browser accessibility tree and keyboard controls were inspected; a full VoiceOver/NVDA reading-order pass was not available and remains part of a human release check.

The browser fixture endpoint is registered only by the Vite development server and is enabled in application code only when `import.meta.env.DEV` is true. It is absent from the static production deployment.
