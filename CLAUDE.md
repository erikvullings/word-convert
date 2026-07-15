# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# Conversion architecture

- Keep raw OOXML extraction, style/metadata proposal analysis, user overrides, and final `DocumentModel` construction separate.
- Heading classification precedence and metadata source priority are specified in `REQUIREMENTS.md`; do not bypass them in readers or writers.
- `@wordconvert/docx-reader` exposes deterministic `stylePreset` and `styleMappings` inputs for conversion reruns.
