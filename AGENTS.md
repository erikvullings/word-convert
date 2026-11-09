# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# CLI

- The CLI (`apps/cli`, binary `wordconvert`) is a thin adapter over the shared readers/writers. For CLI options, release bundles, or local installation, read `documentation/cli.md`. EPUB image optimization uses injected `imageResizer` adapters in CLI/worker; keep encoding media types, generated extensions, and the manifest consistent. Update CLI help, `documentation/cli.md`, and README together when options change.
