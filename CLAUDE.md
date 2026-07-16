# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# Conversion architecture

- Keep raw OOXML extraction, style/metadata proposal analysis, user overrides, and final `DocumentModel` construction separate.
- Heading classification precedence and metadata source priority are specified in `REQUIREMENTS.md`; do not bypass them in readers or writers.
- `@wordconvert/docx-reader` exposes deterministic `stylePreset` and `styleMappings` inputs for conversion reruns.
- `@wordconvert/html-writer` is the semantic reference renderer. Use its fragment mode for previews and apply DOMPurify at the browser insertion boundary; use standalone mode or `writeHtmlZip` for downloads.
- `@wordconvert/markdown-writer` renders the semantic model directly as GFM-compatible Markdown. Use `writeMarkdown` for data-URI images, `writeMarkdownZip` for generated relative image paths, and `onWarning` to collect deterministic Markdown-specific degradation warnings.
- `@wordconvert/epub-writer` renders the semantic model directly as EPUB 3. Keep the stored `mimetype` first, use generated manifest-declared asset paths, split only at top-level H1 boundaries, and keep injected `dcterms:modified` metadata independent from fixed deterministic ZIP timestamps.
- Keep cover composition in `@wordconvert/cover-generator` deterministic and free of browser globals. Bound and sanitize image input before composition; inject browser rasterization through `CoverRasterizer`. EPUB covers must have `cover-image` declarations and must not replace the semantic XHTML title page.
- Keep OMML normalization in `@wordconvert/math-converter` separate from TeX/MathML serialization and KaTeX rendering. Preserve unsupported source diagnostics, keep KaTeX `trust: false`, embed its CSS/font locally, and prefer MathML for EPUB output.
- Keep writer asset paths generated and POSIX-relative. Do not pass source filenames, active media types, or remote resource URLs into HTML output.
- Keep SPA workflow state explicit and structured-clone safe. Persist only preferences and style-mapping presets, never source buffers, models, output, filenames, or document diagnostics.
- Keep the PWA shell base-path safe: manifest, service-worker registration, and precache entries must work under `/word-convert/` and custom `WORDCONVERT_BASE_PATH` builds. Cache only same-origin GET requests and keep conversion independent of the network.
- Route every preview insertion through the shared restrictive DOMPurify policy. Do not allow remote preview URLs or active elements. Release object URLs and output buffers immediately after browser downloads.
- Keep standalone/ZIP output modes in the typed worker protocol, propagate writer warnings with output, and route warning actions to the relevant editor or output setting.
- Validate style presets against `wordconvert.style-preset` version 1 and the complete `StyleMapping` union before applying or persisting them. Render preset and document text only through Mithril text nodes or form values.
- Keep style mappings and metadata edits in explicit SPA state across stages. Re-analysis sends mappings to the reader; metadata edits replace inferred provenance with typed user provenance.
- Keep `apps/web/src/worker` as a thin typed adapter over the core reader/writers. Transfer input/output `ArrayBuffer` ownership, key progress and cancellation by operation ID, return private `ConversionError` objects, and clean up every completed operation.
- Preserve the reader's configurable package, expansion, entry-count, compression-ratio, and per-image limits. Update `documentation/hardening.md` whenever a security boundary, browser support assumption, or representative performance budget changes.
- Keep README setup/deployment commands reproducible and update `THIRD_PARTY_NOTICES.md` whenever runtime dependencies or bundled assets change. Review installed licence and notice files rather than relying on registry summaries.
