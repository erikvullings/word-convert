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
- Existing EPUBs can be shrunk without reconstructing the book, using the same
  image settings, safe output defaults, and bounded archive processing.
- Preserve existing TOCs and generate a missing EPUB 3 nav or EPUB 2 NCX from
  headings, with a spine-document fallback.
- Offer opt-in `--split-chapters` for existing EPUBs, maintaining spine order
  and cross-chapter links; preserve existing file structure by default.
- Document existing automatic PDF header/footer/page-number cleanup and its
  confidence and raster-image limitations.

## Implementation Notes

- CLI parsing and conversion: `apps/cli/src/cli.ts`.
- Native runtime and image encoding: `apps/cli/src/native-runtime.ts` and
  `apps/cli/src/image-resizer.ts`; preserve shared writer boundaries.
- Build/install scripts: `apps/cli/scripts/`; release workflow:
  `.github/workflows/cli.yml`.
- Usage and prerequisites: `documentation/cli.md` and `README.md`.
- Related agent workflow: `skills/fetch-to-epub/SKILL.md`.

## Agent Notes

- 2026-11-09: Extending the CLI to accept existing EPUBs for image optimization
  only. Preserve entry paths and book content, update manifest MIME declarations
  when image encoding changes, and reject encrypted/signed packages rather than
  invalidating their protection. EPUB input is not a semantic import to other
  output formats.

- 2026-11-09: Added this retrospective task after confirming no existing CLI
  task. The CLI originated on `standalone-cli` and was merged into main.
  Keep argument validation and help synchronized with documentation; native
  libraries remain in the portable bundle's adjacent `runtime/` directory.
  Image optimization is injected into the EPUB writer so core code stays
  independent of native/browser globals; media type, extension, and manifest
  must agree after re-encoding. Added the release link to the stage-zero picker
  in `apps/web/src/app.ts` and coverage in `apps/web/src/app.test.ts`.

- 2026-11-09: User requested missing-TOC repair and chose opt-in chapter splitting.
  The earlier unchanged-image-path plan was superseded after EPUBCheck warned
  about JPEG data in `.png` files. `apps/cli/src/shrink-epub.ts` now performs
  bounded archive optimization, `epub-references.ts` rewrites standard static
  references, and `epub-structure.ts` preserves/repairs navigation and optionally
  splits nested H1/H2 chapter boundaries. Preserve body text in EPUBs; PDF
  high-confidence page-furniture cleanup remains in the shared PDF reader.
  Update the shared skill, CLI documentation, and runtime license notices
  alongside this behavior.

- Completion: Added EPUB-input, TOC-repair, chapter-splitting, and source-protection
  coverage in `apps/cli/src/shrink-epub.test.ts`; 190 targeted CLI/EPUB tests pass.
  `apps/cli/scripts/smoke.ts` now exercises the compiled binary on existing EPUBs
  and missing-TOC/chapter-link fixtures. Set `WORDCONVERT_TEST_EPUBCHECK=1` to also
  validate those smoke outputs; both generated fixtures have no errors/warnings.
  Real image-heavy samples shrink about 89% without changing body text or adding
  EPUBCheck diagnostics. Original missing-MathML-property errors remain outside
  this task. Scripts cannot safely track relocated paths, so scripted books
  reject relocation/splitting and can use format-preserving image optimization.
  Existing Unicode replacement characters are retained with an explicit warning.
  The local CLI installation and fetch-to-epub skill were refreshed.

- Compiled-runtime gotcha: css-tree's root ESM entry dynamically requires JSON
  data that Bun does not bundle into the executable. Import parser, generator,
  and walker subpaths instead; declarations in `apps/cli/src/css-tree.d.ts`
  reuse the upstream function types. Source-mode unit tests alone did not catch
  this failure; retain compiled-binary smoke coverage.
