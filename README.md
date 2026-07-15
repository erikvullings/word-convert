# WordConvert

WordConvert is a privacy-preserving, browser-only DOCX conversion workspace. Document input remains local and is converted through a typed neutral document model.

## Browser workflow

The Mithril SPA presents the eight conversion stages from document selection through download in a responsive, keyboard-accessible light/dark shell. The file picker and drag-and-drop target accept `.docx` input, and the interface states clearly that source content is processed only in memory on the current device. Local storage is limited to theme/output preferences and style-mapping presets.

Analysis and output generation run in a Web Worker through a typed protocol with transferable input/output buffers, progress messages, cancellation, private structured errors, and per-operation cleanup. The worker delegates directly to `@wordconvert/docx-reader`, `@wordconvert/html-writer`, and `@wordconvert/markdown-writer`; it contains no conversion logic. The initial flow supports standalone HTML and single-file Markdown downloads.

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
