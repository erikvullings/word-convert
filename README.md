# WordConvert

WordConvert is a privacy-preserving, browser-only DOCX conversion workspace. Document input remains local and is converted through a typed neutral document model.

The static site is also an installable progressive web app. After one successful
load, its application shell is cached for offline use; document conversion and
downloads continue to run entirely on the device.

It accepts unencrypted `.docx` files and produces standalone HTML, an HTML ZIP,
single-file Markdown, a Markdown ZIP, or a reflowable EPUB 3 publication. Legacy
`.doc`, encrypted documents, and macro-enabled `.docm` files are rejected.

## Browser workflow

The Mithril SPA presents the eight conversion stages from document selection through download in a responsive, keyboard-accessible light/dark shell. The file picker and drag-and-drop target accept `.docx` input, and the interface states clearly that source content is processed only in memory on the current device. Local storage is limited to theme/output preferences and style-mapping presets.

The security defaults cap DOCX input at 50 MiB compressed, 200 MiB expanded, 1,000 ZIP entries, a 100:1 per-entry compression ratio, and 25 MiB per image. Hosts may override these typed reader limits deliberately. See [hardening and browser verification](documentation/hardening.md) for the threat-to-test matrix, performance budget, compatibility policy, and interactive evidence.

Analysis and output generation run in a Web Worker through a typed protocol with transferable input/output buffers, progress messages, cancellation, private structured errors, and per-operation cleanup. The worker delegates directly to the reader and output writers; it contains no conversion logic. Output settings cover standalone or packaged HTML, single-file or packaged Markdown, EPUB, embedded or generated-folder assets, formula rendering, and optional EPUB covers. Every setting can be changed and rerun without re-uploading the source; generated object URLs and output buffers are released immediately after download.

HTML and rendered Markdown previews pass through DOMPurify with active elements, inline styling, remote URLs, and unknown protocols blocked. EPUB previews expose the generated package structure and passive contents. Conversion warnings link back to the relevant style, metadata, formula, asset, or output setting.

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

## EPUB output

`@wordconvert/epub-writer` exposes `writeEpub` for deterministic, reflowable EPUB 3 output. It writes the stored `mimetype` entry first, then the container, package metadata, navigation document, title page, H1-based XHTML chapters, local stylesheet, and generated passive image/font assets with a complete manifest and spine.

Required identifier, title, language, and EPUB modification time can come from the document model or typed writer overrides. ZIP entries use a fixed 1980 timestamp and stable order for byte-identical output; the independently injected `dcterms:modified` value records the publication modification time required by EPUB 3. The writer omits remote links, active media, SVG, scripts, event handlers, iframes, unsafe URLs, and unsupported resources. Install `epubcheck` to enable the focused local conformance test.

## EPUB covers

`@wordconvert/cover-generator` creates deterministic, browser-independent SVG compositions for image-only, overlay, title-panel, separate-title-page, and generated typographic covers. It accepts bounded JPEG, PNG, WebP, and sanitized SVG inputs, uses only system-safe font families, and exposes rasterization through an injected adapter for browser-only compatibility paths.

The EPUB editor can omit a cover, upload an image, choose a supported extracted document image, or generate a typographic cover. Its live preview exposes crop, alignment, title and author positions and sizes, text colour, contrast panel and opacity, image opacity, safe margins, and aspect ratio. A conservative filename heuristic explains when an image may already contain title text. Generated EPUBs declare the cover image and cover page while always retaining a separate semantic XHTML title page.

## Formula output

`@wordconvert/math-converter` converts a safe OMML subset into a normalized math tree and independent TeX and MathML serializations. The supported subset covers inline and display equations, fractions, roots, matrices, subscripts, superscripts, and Unicode mathematical symbols. Unsupported or malformed OMML retains bounded diagnostic text and produces a `formula-conversion-incomplete` warning.

HTML, Markdown, EPUB, and browser previews support source fallback, accessible MathML, pre-rendered KaTeX, and disabled formula modes. KaTeX runs with strict errors and `trust: false`; its CSS and font are embedded locally without network requests. EPUB defaults to MathML for accessibility and compatibility. Formula conversion is intentionally incomplete for uncommon OMML constructs, which use the source fallback rather than being silently discarded.

## Known conversion limitations

WordConvert preserves semantic document structure rather than Word's paginated
layout. Page breaks, exact line wrapping, floating shapes, text boxes, columns,
watermarks, and desktop-font metrics may therefore differ or be omitted. Headers,
footers, comments, and tracked deletions are inspected but omitted from the main
content with a warning. Complex table spans, uncommon list definitions, active
SVG, unsafe links, unsupported image formats, and uncommon OMML constructs may be
degraded or replaced by a safe fallback. Always review the preview and warnings
before publishing.

Heading proposals combine OOXML outline levels, stable Word style IDs, document
structure, localized aliases, inheritance, typography, and usage patterns; font
size alone never creates a heading. The style-review stage shows confidence and
evidence and lets the user override every mapping. Metadata is similarly inferred
from document properties, semantic styles, first-page structure, and the filename.
Its provenance and confidence remain visible, and publication, source, and
conversion dates remain separate.

Cover creation supports a safe uploaded or extracted image, deterministic
typographic SVG, image/text overlays, or no cover. SVG is sanitized, remote fonts
are forbidden, and every EPUB retains a semantic XHTML title page. Browser-side
rasterization is adapter-driven and may vary slightly between rendering engines.

## Privacy and security

Conversion runs locally in a Web Worker. WordConvert has no analytics and does not
send document bytes, text, metadata, filenames, images, or diagnostics over the
network. Source data and generated output stay in memory; local storage contains
only preferences and validated style presets. A static host can serve the app
without a conversion service.

The default reader limits are 50 MiB compressed input, 200 MiB expanded content,
1,000 ZIP entries, a 100:1 per-entry compression ratio, and 25 MiB per image.
Unsafe XML, paths, links, HTML, SVG, and remote resources are rejected or
sanitized. Raising these typed limits increases memory exposure. See the
[hardening checklist](documentation/hardening.md) for the complete threat matrix,
browser support policy, performance budget, and known manual release gates.

## Development and testing

WordConvert requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server opens the Vite SPA at the printed local URL. Run the full
repository quality gates before submitting a change:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Regenerate the synthetic DOCX corpus with `pnpm fixtures:generate`, then confirm
that `git diff --exit-code -- tests/fixtures/docx` is empty. See
[fixture documentation](tests/fixtures/docx/README.md) for its deterministic
manifest and generated-in-memory security cases.

Interactive browser verification uses the standard comprehensive fixture and the
eight-stage checklist in [hardening and browser verification](documentation/hardening.md).
The current and previous major Chrome, Edge, Firefox, and Safari releases are the
support target; Chromium is automated/recorded, while direct Firefox and Safari
runs remain a human release gate.

Install the `epubcheck` executable and ensure it is on `PATH`, then run:

```sh
pnpm exec vitest run packages/epub-writer/src/index.test.ts
```

The focused suite detects EPUBCheck automatically and runs its conformance case;
without the executable that case is explicitly skipped. A successful validation
reports no EPUB errors or warnings.

More contributor detail, including exact fixture, browser, EPUBCheck, and build
commands, is in [tooling](documentation/tooling.md). The stable model,
reader/writer contracts, privacy boundaries, security limits, and future
Rust/WASM adapter path are documented in [core contracts](documentation/core-contracts.md).

## GitHub Pages deployment

Production builds default to the `/word-convert/` base path. For another repository
name, include both slashes when overriding it:

```sh
WORDCONVERT_BASE_PATH=/my-repository/ pnpm build
```

The `Verify and deploy WordConvert` workflow builds `apps/web/dist` on pushes to
`main` and deploys it with GitHub's Pages actions. Pull requests run the same
frozen install, formatting, lint, strict type, test, EPUBCheck, production build,
and static/offline-output checks without deployment permissions. In repository
settings, select **GitHub Actions** as the Pages source, then run the workflow or
push to `main`. The deployment is static; it requires no secrets or conversion
backend.

## Future Rust/WASM reader

The browser-independent `DocxReader` interface accepts exact `Uint8Array` input
and explicit JSON-safe options and returns the versioned, serializable
`DocumentModel`. A future `WasmDocxReader` can implement that boundary while the
TypeScript writers, worker protocol, and UI remain unchanged. The current plan is
to move parsing only when representative fixtures show a measurable benefit, not
to rewrite output generation prematurely.

## Licence and attribution

WordConvert is released under the [MIT License](LICENSE). Reviewed runtime
dependency licences and copyright notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Re-run the documented licence
audit whenever `pnpm-lock.yaml` changes.
