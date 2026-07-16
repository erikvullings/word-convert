# WordConvert

WordConvert is a privacy-preserving, browser-only DOCX conversion workspace. Document input remains local and is converted through a typed neutral document model.

## Browser workflow

The Mithril SPA presents the eight conversion stages from document selection through download in a responsive, keyboard-accessible light/dark shell. The file picker and drag-and-drop target accept `.docx` input, and the interface states clearly that source content is processed only in memory on the current device. Local storage is limited to theme/output preferences and style-mapping presets.

The security defaults cap DOCX input at 50 MiB compressed, 200 MiB expanded, 1,000 ZIP entries, a 100:1 per-entry compression ratio, and 25 MiB per image. Hosts may override these typed reader limits deliberately. See [hardening and browser verification](documentation/hardening.md) for the threat-to-test matrix, performance budget, compatibility policy, and interactive evidence.

Analysis and output generation run in a Web Worker through a typed protocol with transferable input/output buffers, progress messages, cancellation, private structured errors, and per-operation cleanup. The worker delegates directly to the reader and output writers; it contains no conversion logic. Output settings cover standalone or packaged HTML, single-file or packaged Markdown, EPUB, embedded or generated-folder assets, formula rendering, and optional EPUB covers. Every setting can be changed and rerun without re-uploading the source; generated object URLs and output buffers are released immediately after download.

HTML and rendered Markdown previews pass through DOMPurify with active elements, inline styling, remote URLs, and unknown protocols blocked. EPUB previews expose the generated package structure and passive contents. Conversion warnings link back to the relevant style, metadata, formula, asset, or output setting.

The style review table exposes each proposal, confidence, evidence, examples, effective formatting, and every semantic mapping. Mappings can be edited individually, accepted in bulk when confidence is high, and applied by rerunning analysis. Versioned JSON presets can be validated, imported, exported as plain text, and saved locally; invalid schema versions and mapping values are rejected.

The metadata review stage covers title, subtitle, structured authors, language, publisher, description, subjects, version, source creation and modification dates, publication and conversion dates, identifier, and rights. Each value shows its provenance, confidence, and extracted, inferred, default, or user-edited status. Editor state remains in memory while moving between workflow stages.

## Style and metadata analysis

`@wordconvert/docx-reader` separates OOXML extraction from analysis and final model construction. `analyseStyles` reports every used paragraph and character style with inherited effective formatting, usage samples, a proposed semantic mapping, confidence, and reasons. Heading evidence follows the documented precedence; font size is never sufficient by itself.

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

The EPUB editor can omit a cover, upload an image, choose a supported extracted document image, or generate a typographic cover. Its live preview exposes crop, alignment, title and author positions and sizes, text colour, contrast panel and opacity, image opacity, safe margins, and aspect ratio. A conservative filename heuristic explains when an image may already contain title text. Generated EPUBs declare the cover image and cover page while always retaining a separate semantic XHTML title page.

## Formula output

`@wordconvert/math-converter` converts a safe OMML subset into a normalized math tree and independent TeX and MathML serializations. The supported subset covers inline and display equations, fractions, roots, matrices, subscripts, superscripts, and Unicode mathematical symbols. Unsupported or malformed OMML retains bounded diagnostic text and produces a `formula-conversion-incomplete` warning.

HTML, Markdown, EPUB, and browser previews support source fallback, accessible MathML, pre-rendered KaTeX, and disabled formula modes. KaTeX runs with strict errors and `trust: false`; its CSS and font are embedded locally without network requests. EPUB defaults to MathML for accessibility and compatibility. Formula conversion is intentionally incomplete for uncommon OMML constructs, which use the source fallback rather than being silently discarded.
