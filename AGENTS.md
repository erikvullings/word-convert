# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# CLI

- The CLI (`apps/cli`, binary `wordconvert`) uses shared readers/writers for document conversions and a separate bounded archive-preserving path for existing EPUBs. For CLI options, EPUB shrinking/chapter organization, release bundles, or local installation, read `documentation/cli.md`. EPUB image optimization uses injected `imageResizer` adapters in CLI/worker; keep encoding media types, generated extensions, and the manifest consistent. Update CLI help, `documentation/cli.md`, and README together when options change.
