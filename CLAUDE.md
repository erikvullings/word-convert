# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# Conversion architecture

- Keep raw OOXML extraction, style/metadata proposal analysis, user overrides, and final `DocumentModel` construction separate.
- Heading classification precedence and metadata source priority are specified in `REQUIREMENTS.md`; do not bypass them in readers or writers.
- `@wordconvert/docx-reader` exposes deterministic `stylePreset` and `styleMappings` inputs for conversion reruns.
- `@wordconvert/html-writer` is the semantic reference renderer. Use its fragment mode for previews and apply DOMPurify at the browser insertion boundary; use standalone mode or `writeHtmlZip` for downloads.
- `@wordconvert/markdown-writer` renders the semantic model directly as GFM-compatible Markdown. Use `writeMarkdown` for data-URI images, `writeMarkdownZip` for generated relative image paths, and `onWarning` to collect deterministic Markdown-specific degradation warnings.
- Keep writer asset paths generated and POSIX-relative. Do not pass source filenames, active media types, or remote resource URLs into HTML output.
- Keep SPA workflow state explicit and structured-clone safe. Persist only preferences and style-mapping presets, never source buffers, models, output, filenames, or document diagnostics.
- Keep `apps/web/src/worker` as a thin typed adapter over the core reader/writers. Transfer input/output `ArrayBuffer` ownership, key progress and cancellation by operation ID, return private `ConversionError` objects, and clean up every completed operation.
