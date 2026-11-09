# 0030 Add portable CLI and release bundles

Status: done
Priority: medium
Owner: unassigned
Agent: GitHub Copilot
Subsystem: cli
Depends on: none

## Context

Record the already-delivered `wordconvert` CLI for future maintenance. The CLI
provides on-device conversion outside the browser, reusing the shared semantic
readers and writers rather than maintaining a separate conversion engine.
The GitHub Pages landing page should make the downloadable CLI discoverable.

## Acceptance Criteria

- Local DOCX, PDF, Markdown, and HTML inputs support HTML, packaged HTML,
  Markdown, packaged Markdown, and EPUB output.
- Portable macOS, Linux, and Windows bundles are built by GitHub Actions;
  `cli-v*` tags publish release bundles and checksums.
- Installation, model caching, offline operation, metadata overrides, and
  optional native PDF inference are documented.
- EPUB image optimization defaults to a 1600 px longest edge, opaque JPEG
  quality 80, with dimension, format, and quality overrides.
- The SPA landing page names `wordconvert` and links to GitHub Releases.

## Implementation Notes

- CLI parsing and conversion: `apps/cli/src/cli.ts`.
- Native runtime and image encoding: `apps/cli/src/native-runtime.ts` and
  `apps/cli/src/image-resizer.ts`; preserve shared writer boundaries.
- Build/install scripts: `apps/cli/scripts/`; release workflow:
  `.github/workflows/cli.yml`.
- Usage and prerequisites: `documentation/cli.md` and `README.md`.
- Related agent workflow: `skills/fetch-to-epub/SKILL.md`.

## Agent Notes

- 2026-11-09: Added this retrospective task after confirming no existing CLI
  task. The CLI originated on `standalone-cli` and was merged into main.
  Keep argument validation and help synchronized with documentation; native
  libraries remain in the portable bundle's adjacent `runtime/` directory.
  Image optimization is injected into the EPUB writer so core code stays
  independent of native/browser globals; media type, extension, and manifest
  must agree after re-encoding. Added the release link to the stage-zero picker
  in `apps/web/src/app.ts` and coverage in `apps/web/src/app.test.ts`.
