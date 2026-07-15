# WordConvert

WordConvert is a privacy-preserving, browser-only DOCX conversion workspace. Document input remains local and is converted through a typed neutral document model.

## Style and metadata analysis

`@wordconvert/docx-reader` separates OOXML extraction from analysis and final model construction. `analyseStyles` reports every used paragraph and character style with inherited effective formatting, usage samples, a proposed semantic mapping, confidence, and reasons. Heading evidence follows the documented precedence; font size is never sufficient by itself.

Callers can pass `stylePreset` and `styleMappings` to `DocxReaderOptions`. Explicit mappings take precedence over presets and inferred evidence, making reruns deterministic. `resolveMetadataCandidates` selects metadata by source priority while retaining provenance and confidence, structured authors, and separate source, publication, and conversion dates.

## HTML output

`@wordconvert/html-writer` exposes `writeHtml` for deterministic standalone HTML or a preview fragment, and `writeHtmlZip` for an editable package containing `document.html`, `styles.css`, and generated `images/` and `fonts/` paths. The serializer covers every document-model node, builds a heading table of contents, embeds standalone assets, and emits script-free offline output with print and reader light/dark styles.

The writer escapes document content and metadata, accepts only safe link schemes and passive image/font media, and never trusts source asset filenames. Browser callers must still apply DOMPurify before inserting preview fragments into the DOM.
