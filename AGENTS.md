# Environment Setup
- Local macOS capabilities and optimized CLI tools are mapped in `~/.config/ai/tools.md`. Read this file to use optimized search/replace and parsing binaries.

# CLI

- The CLI (`apps/cli`, binary `wordconvert`, documented in `documentation/cli.md` and the README) is a thin adapter over the same readers/writers; the `cli-v*` tag workflow publishes releases and `pnpm cli:install -- --force` upgrades the local install. EPUB images are downscaled to a longest edge of 1600 px by default (`maxImageDimension`, CLI `--max-image-size <px>`, 0 disables); resizing is injected via `imageResizer` (canvas in the CLI and worker), so keep the writer free of native/browser globals. Update the CLI help, `documentation/cli.md`, and README together when options change.
