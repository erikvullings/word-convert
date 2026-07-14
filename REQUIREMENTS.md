Build an open-source browser application named **WordConvert** that converts Microsoft Word `.docx` documents into Markdown, standalone HTML, or EPUB 3.

WordConvert must be privacy-preserving and deployable as a completely static GitHub Pages application. Document content, metadata, filenames, images and diagnostics must never be uploaded. All conversion must happen locally.

## Technology

Use:

- Vite;
- modern ESM syntax throughout;
- the latest stable TypeScript version, configured strictly and kept compatible with the upcoming TypeScript 7 native compiler;
- Mithril.js;
- `mithril-materialized` for GUI components;
- Vitest for module and integration tests;
- JSZip or an equivalent browser-compatible ZIP implementation;
- DOMPurify for sanitizing preview content;
- Turndown, where appropriate, for Markdown generation;
- KaTeX as an optional mathematical formula renderer.

Do not use React, Vue, Angular or a server-side framework.

Do not require Playwright by default. Use Codex’s built-in browser for interactive visual testing. When the user-provided `browsertools` skill is available, use it for repeatable browser interaction and screenshots. Add Playwright or another browser-testing dependency only when neither Codex’s browser nor `browsertools` can provide an essential repeatable CI smoke test.

## Architecture

Use a workspace or similarly modular source structure.

Separate the application into:

- a Mithril web application;
- a browser/Web Worker adapter;
- a DOCX reader and analyzer;
- a browser-independent semantic document model;
- a Markdown writer;
- an HTML writer;
- an EPUB writer;
- a mathematical-expression converter;
- a cover generator;
- shared validation and security utilities.

The core conversion modules must:

- have no dependency on Mithril;
- have no dependency on browser DOM globals;
- accept `Uint8Array`, plain objects and explicit options;
- return plain serializable typed data;
- run in Node.js under Vitest;
- also run in a browser or Web Worker;
- be deterministic;
- be testable without starting the SPA.

Define a central semantic `DocumentModel` containing:

- document metadata;
- block nodes;
- inline nodes;
- images and other assets;
- equations;
- footnotes and references;
- analyzed Word styles;
- conversion warnings;
- source provenance for inferred values.

Do not make HTML the central internal representation. Generate Markdown, HTML and EPUB independently from the semantic model.

Define a `DocxReader` interface so that the initial TypeScript implementation can later be replaced by, or compared with, a Rust/WASM implementation without changing the writers or GUI.

## DOCX support

Initially support unencrypted `.docx` files only.

Reject with a clear explanation:

- legacy `.doc`;
- encrypted or password-protected documents;
- unsupported macro-enabled content;
- malformed ZIP packages;
- unsafe or excessively large input.

Inspect the OOXML package directly where necessary, including:

- `word/document.xml`;
- `word/styles.xml`;
- numbering definitions;
- relationships;
- core properties;
- extended properties;
- custom properties;
- footnotes and endnotes;
- embedded media;
- headers and footers;
- Office Math Markup Language;
- language settings;
- style inheritance;
- outline levels.

Mammoth.js may be used as one component of conversion, but WordConvert must not depend solely on Mammoth when direct OOXML inspection is required for metadata, style inference, equations or structure.

Do not include page headers, page footers, watermark shapes or other repetitive decorative page furniture in the main converted document by default. Report omitted content in the warnings panel.

## Style analysis and heading inference

Before final conversion, inspect every paragraph and character style used in the document.

Produce a style-analysis model containing:

- style ID;
- localized style name;
- base style;
- outline level;
- font family;
- effective font size;
- bold and italic state;
- spacing before and after;
- indentation;
- numbering information;
- number of uses;
- example paragraphs;
- proposed semantic mapping;
- confidence score;
- reasons for the proposal.

Classify document structure using this precedence:

1. explicit user mapping;
2. OOXML outline level;
3. built-in Word style ID;
4. table-of-contents or outline relationships;
5. localized style-name aliases;
6. style inheritance;
7. typographic and structural inference;
8. plain paragraph fallback.

Do not infer headings from font size alone. Combine relative font-size rank with:

- paragraph length;
- boldness;
- spacing;
- numbering;
- position;
- frequency;
- style inheritance;
- repeated structure;
- relationship to the dominant body style.

Display the analysis in an editable style-mapping screen before conversion.

For every style, show:

- proposed semantic type;
- confidence;
- sample text;
- effective formatting;
- mapping selector.

Allow mappings such as:

- title;
- subtitle;
- author;
- heading 1–6;
- body paragraph;
- blockquote;
- caption;
- code;
- footnote;
- ignore.

Allow users to:

- accept all high-confidence mappings;
- edit individual mappings;
- save mapping presets locally;
- import and export mapping presets as JSON;
- rerun conversion after mapping changes.

Support localized style names for European languages, but prefer stable OOXML style IDs and outline levels over translated names. Include aliases for common title, subtitle, heading, caption and quotation styles in European languages.

## Metadata

Extract candidate metadata from:

1. DOCX core properties;
2. DOCX extended properties;
3. DOCX custom properties;
4. explicit Title, Subtitle and Author styles;
5. first-page structure;
6. inferred cover-page content;
7. the source filename.

Extract and display editable fields for:

- title;
- subtitle;
- one or more authors;
- language;
- publisher;
- description;
- subjects or keywords;
- version;
- rights;
- identifier;
- original document creation date;
- original document modification date;
- publication date;
- conversion date.

Default the conversion date to the current local date.

Default the publication date to a detected publication date when confidence is high; otherwise default it to the current date and clearly mark it as a default.

Keep source creation, source modification, publication and conversion dates as separate values.

Show the provenance and confidence of every inferred metadata field so users can verify and edit it.

Support multiple authors as structured entries rather than one comma-separated string.

Generate valid EPUB metadata, including the required package identifier, title, language and modified timestamp.

## Markdown output

Offer:

1. a ZIP containing Markdown plus an `images` directory;
2. a single Markdown file with embedded data-URI images.

Preserve, where feasible:

- headings;
- paragraphs;
- emphasis;
- hyperlinks;
- ordered and unordered lists;
- nested lists;
- blockquotes;
- code blocks;
- tables;
- footnotes;
- images;
- captions;
- mathematical expressions.

Use deterministic, safe asset names and relative POSIX paths in ZIP output.

## HTML output

Offer:

1. a self-contained standalone HTML file;
2. optionally, an HTML ZIP containing the HTML, CSS, fonts and image assets.

Standalone HTML must:

- include semantic HTML;
- include an automatically generated table of contents;
- include embedded CSS;
- embed images as data URIs;
- contain no external network dependencies;
- contain no scripts unless explicitly required for a safe optional feature;
- work when opened directly from disk;
- be printable;
- support light and dark reader preferences;
- include KaTeX CSS and fonts locally when formulas are rendered with KaTeX.

Use the HTML writer for the application preview, but sanitize all preview content before inserting it into the DOM.

## Formula support

Word native equations are represented as Office Math Markup Language, not TeX.

Implement an optional formula-processing pipeline:

- detect and extract OMML;
- convert supported OMML to a normalized internal math node;
- convert supported formulas to MathML or TeX;
- optionally render TeX through KaTeX;
- retain the original OMML or a diagnostic representation for unsupported equations;
- emit a conversion warning when formula conversion is incomplete.

Provide formula modes:

- preserve source/fallback;
- MathML;
- KaTeX;
- disabled.

When KaTeX is enabled:

- use `katex.renderToString()` where practical so rendering works outside the browser;
- set safe options;
- do not enable unsafe trust features;
- escape untrusted formula source and errors;
- bundle all required CSS and fonts locally;
- never fetch remote assets.

For EPUB, prefer accessible MathML where practical and allow KaTeX-rendered HTML or generated SVG as a fallback.

Add tests for:

- inline formulas;
- display formulas;
- fractions;
- roots;
- matrices;
- superscripts and subscripts;
- unsupported OMML;
- malicious formula source;
- Unicode mathematical symbols.

## EPUB output

Generate a valid reflowable EPUB 3 publication.

Include:

- the uncompressed `mimetype` file as the first ZIP entry;
- `META-INF/container.xml`;
- an OPF package document;
- a navigation document;
- XHTML chapters;
- local stylesheets;
- local images;
- local KaTeX assets when enabled;
- a manifest;
- a valid spine;
- metadata;
- cover-image declarations;
- an XHTML title page.

Split chapters primarily at Heading 1 boundaries, while avoiding invalid splits inside lists, tables, quotations or other nested structures.

Generate table-of-contents entries from semantic headings.

Correctly escape XML and XHTML.

Prohibit:

- JavaScript;
- inline event handlers;
- remote stylesheets;
- remote images;
- iframes;
- `javascript:` URLs;
- active or unsafe SVG;
- undeclared manifest resources.

## EPUB cover

Allow the user to:

- upload a front-cover image;
- use a suitable image extracted from the source document;
- generate a typographic cover;
- omit the cover.

Accept safe JPEG, PNG, WebP and sanitized SVG input where supported.

Provide cover layouts:

- image only;
- title and authors over the image;
- title panel over the image;
- separate image cover and semantic title page.

When title overlay is enabled:

- display the title near the top by default;
- display subtitle below it;
- display author names near the bottom;
- offer light or dark text;
- offer an optional translucent contrast panel;
- allow alignment, size, position, opacity and crop settings;
- maintain safe margins;
- show a live preview;
- warn when the source image already appears to contain title text.

Generate the cover from a deterministic SVG composition and rasterize it when needed for reading-system compatibility.

Always include a semantic XHTML title page even when the rasterized cover contains the title and authors.

Do not use remote fonts.

## GUI

Build the SPA with Mithril.js and `mithril-materialized`.

The application name and page title are **WordConvert**.

Provide a workflow with these stages:

1. Select document;
2. Analyze document;
3. Review styles;
4. Review metadata;
5. Configure output;
6. Configure EPUB cover;
7. Preview;
8. Convert and download.

Include:

- drag-and-drop;
- accessible file input;
- progress reporting;
- cancellation;
- conversion warnings;
- metadata editor;
- style-mapping editor;
- formula options;
- cover editor;
- HTML preview;
- Markdown preview;
- EPUB structure summary;
- responsive layout;
- keyboard navigation;
- light and dark mode;
- local preference storage;
- no analytics;
- no external fonts;
- a clear statement that all processing is local.

Never store source document content in local storage or IndexedDB unless the user explicitly enables a future session-persistence feature.

## Web Worker

Run document analysis and conversion inside a Web Worker.

The worker must be a thin adapter around the browser-independent conversion packages.

Support:

- progress messages;
- cancellation;
- structured errors;
- transferable `ArrayBuffer` objects;
- cleanup after conversion.

Do not duplicate conversion logic in the worker.

## Security and resilience

Protect against:

- ZIP bombs;
- excessive entry counts;
- excessive expanded size;
- extreme compression ratios;
- path traversal;
- malformed XML;
- XML entity expansion;
- unsafe hyperlinks;
- active SVG content;
- unsafe HTML;
- remote resource loading;
- unexpectedly large images;
- memory exhaustion;
- script injection through metadata, formulas or filenames.

Use configurable limits.

Do not log document text, metadata or image data.

## Testing

Use Vitest for the conversion packages.

Tests must run without a browser for:

- DOCX package inspection;
- metadata extraction;
- style analysis;
- heading inference;
- document-model generation;
- Markdown generation;
- HTML generation;
- EPUB generation;
- cover generation where no browser canvas is required;
- XML escaping;
- sanitization utilities;
- asset naming;
- formula conversion;
- malformed input;
- security limits;
- deterministic output.

Create fixture DOCX files covering:

- standard Word heading styles;
- custom styles;
- localized European style names;
- visually formatted but semantically unstyled headings;
- lists and nested lists;
- tables;
- hyperlinks;
- footnotes and endnotes;
- comments and tracked changes;
- headers, footers and watermarks;
- multiple images;
- cover pages;
- metadata;
- OMML equations;
- Unicode;
- right-to-left text;
- malformed packages;
- large compressed entries.

Use model snapshots where appropriate, but prefer precise structural assertions for critical behavior.

Use Codex’s internal browser for interactive testing of the built application.

When the `browsertools` skill is available, use it to test:

- file selection;
- drag-and-drop;
- style editing;
- metadata editing;
- formula settings;
- cover layout;
- output selection;
- preview;
- download actions;
- responsive behavior;
- keyboard navigation;
- dark mode;
- absence of unexpected network requests.

Do not add Playwright unless an essential automated CI browser test cannot be implemented using the available Codex browser or `browsertools`.

Generate EPUB fixtures during tests and validate them with EPUBCheck in CI.

## CI and deployment

Create GitHub Actions workflows for:

- dependency installation;
- formatting;
- linting;
- TypeScript checking;
- Vitest;
- production build;
- generated EPUB validation with EPUBCheck;
- GitHub Pages deployment.

Configure Vite correctly for deployment beneath a GitHub repository path.

## Rust/WASM readiness

Do not implement the initial converter entirely in Rust/WASM unless repository analysis demonstrates that an existing Rust DOCX parser can be reused with less complexity than the TypeScript approach.

Instead:

- define a stable `DocxReader` interface;
- make `DocumentModel` JSON-serializable;
- avoid JavaScript class instances in the cross-module model;
- document the expected WASM boundary;
- add representative performance fixtures;
- make it possible to introduce a `WasmDocxReader` later.

If an existing Rust DOCX parser is present in the repository, inspect it and write a short technical assessment comparing:

- extending the TypeScript reader;
- compiling the Rust parser to WASM;
- using Rust only for DOCX parsing;
- keeping output writers in TypeScript.

Do not perform a premature full rewrite in Rust.

## Documentation

Write a README covering:

- WordConvert’s purpose;
- local-only privacy model;
- supported input;
- supported outputs;
- known Word conversion limitations;
- formula support and limitations;
- heading-inference behavior;
- metadata inference;
- cover generation;
- development;
- testing;
- GitHub Pages deployment;
- security limits;
- EPUB validation;
- future Rust/WASM integration.

Include an open-source licence and required dependency attribution.

## Implementation approach

First:

1. inspect the repository and available skills;
2. produce a concise architecture and implementation plan;
3. identify reusable existing code;
4. define `DocumentModel`, `DocxReader` and writer interfaces;
5. create representative fixtures and tests.

Then implement the system in vertical slices:

1. DOCX analysis and semantic model;
2. HTML output and preview;
3. Markdown output;
4. metadata extraction and editing;
5. style analysis and mapping;
6. EPUB output;
7. cover generation;
8. formulas;
9. hardening, browser testing and CI.

Run all available tests, build the application, inspect generated outputs, validate generated EPUB files with EPUBCheck, test the UI using Codex’s browser or `browsertools`, and fix discovered failures.

Do not leave core conversion functions as placeholders or TODOs. Clearly document any unsupported Word constructs instead of silently discarding them.

## Recommended Architecture

WordConvert
│
├── apps/
│ └── web/
│ ├── Mithril.js SPA
│ ├── mithril-materialized components
│ ├── Web Worker adapter
│ ├── preview
│ └── download handling
│
├── packages/
│ ├── docx-reader/
│ │ ├── ZIP/package inspection
│ │ ├── Word metadata extraction
│ │ ├── style analysis
│ │ ├── image extraction
│ │ ├── OMML extraction
│ │ └── DOCX → DocumentModel
│ │
│ ├── document-model/
│ │ ├── semantic blocks
│ │ ├── inline content
│ │ ├── metadata
│ │ ├── assets
│ │ └── conversion warnings
│ │
│ ├── markdown-writer/
│ │ └── DocumentModel → Markdown
│ │
│ ├── html-writer/
│ │ └── DocumentModel → standalone HTML
│ │
│ ├── epub-writer/
│ │ └── DocumentModel → EPUB 3
│ │
│ ├── math-converter/
│ │ ├── OMML → MathML or TeX
│ │ └── TeX → KaTeX HTML
│ │
│ └── cover-generator/
│ └── image + title + authors → cover
│
└── tests/
├── DOCX fixtures
├── model snapshots
├── output snapshots
├── EPUBCheck
└── browser smoke tests

### Neutral Document Model

export interface ConvertedDocument {
metadata: DocumentMetadata;
blocks: BlockNode[];
assets: AssetMap;
styles: AnalysedStyle[];
warnings: ConversionWarning[];
}

export interface DocumentMetadata {
title?: string;
subtitle?: string;
authors: Person[];
language?: string;
publisher?: string;
description?: string;
subject?: string[];
version?: string;
sourceCreatedAt?: string;
sourceModifiedAt?: string;
publicationDate?: string;
conversionDate: string;
identifier?: string;
rights?: string;
}

export type BlockNode =
| HeadingNode
| ParagraphNode
| ListNode
| TableNode
| BlockQuoteNode
| CodeBlockNode
| MathBlockNode
| ImageBlockNode
| HorizontalRuleNode
| PageBreakNode;

This allows you to test:

const model = await readDocx(buffer, options);
const markdown = writeMarkdown(model, options);
const html = writeHtml(model, options);
const epub = await writeEpub(model, options);

None of those modules should access:

window
document
file picker APIs
Mithril
browser download APIs
Web Worker globals

The worker and Node.js tests should call the same conversion API.

HTML output

I would offer two HTML forms:

Standalone HTML

One downloadable .html file containing:

semantic HTML
embedded CSS
images as data URIs
optionally embedded KaTeX CSS and fonts
table of contents
document metadata
no external network dependencies
HTML ZIP

For large documents:

document.html
styles.css
images/
fonts/

This avoids very large data URLs and is better for editing or publishing.

The HTML writer should be the reference renderer. The preview can use the same generated document fragment, sanitized before insertion into the browser.

Formulas and KaTeX

KaTeX is useful, but it does not solve the complete conversion problem by itself.

Word stores native equations as OMML, not TeX. KaTeX accepts TeX-like input and can produce deterministic HTML in Node.js or the browser.

The pipeline therefore needs to be:

DOCX OMML
↓
OMML parser/converter
↓
TeX or MathML
↓
KaTeX rendering, when enabled

I suggest three math modes:

type MathOutputMode =
| "source"
| "mathml"
| "katex";
source: preserve unconverted OMML as a warning or fallback image/text.
mathml: output MathML when conversion succeeds.
katex: convert to TeX and pre-render using katex.renderToString().

KaTeX should be optional because:

not every OMML construct has a straightforward TeX equivalent;
KaTeX supports a large but not complete subset of TeX;
EPUB readers vary in their support for complex HTML/CSS;
bundling KaTeX fonts increases EPUB and standalone HTML size.

For EPUB, the most robust choices are:

MathML where the reader supports it.
KaTeX-generated HTML plus bundled CSS/fonts.
A generated SVG fallback.

An advanced implementation could include MathML with an SVG fallback, but that belongs after the MVP.

Because equations originate from an untrusted document, the math converter must escape error text and source expressions. KaTeX explicitly warns that unescaped error/source content can create an injection risk.

Extracting metadata

The app should inspect several sources in priority order:

1. DOCX core properties
2. DOCX extended and custom properties
3. document title paragraph
4. cover-page structure
5. filename
6. user edits

Candidate fields:

WordConvert field Possible source
Title Core property, Title style, largest first-page text
Subtitle Subtitle style or secondary first-page heading
Authors Core creator, last modified by, author paragraph
Language Core properties, document defaults, paragraph languages
Publisher Custom property or user entry
Version Custom property, revision property or user entry
Publication date Custom property, detected cover-page date or current date
Conversion date Current local date by default
Description Subject/comments/core description
Keywords Core keywords
Rights Custom property or user entry
Identifier Existing identifier or generated UUID

EPUB metadata should distinguish:

the source document’s creation date;
its apparent publication date;
the date WordConvert produced the EPUB;
the EPUB package’s required modification timestamp.

EPUB package metadata is used by readers for title and author display, and the package also defines its manifest and reading order.

The metadata editor should show provenance:

Title
"The European Security Review"
Detected from: Word core properties

Authors
"Jane Smith; John Example"
Detected from: document properties

That makes incorrect inference easy to spot.

EPUB front cover

Support:

uploaded JPEG, PNG, WebP or SVG;
extracted first-page image;
automatically generated typographic cover;
no cover.

For an uploaded image, provide cover modes:

type CoverLayout =
| "image-only"
| "overlay"
| "title-panel"
| "separate-title-page";
Overlay mode

Render:

title near the top;
subtitle below it;
authors near the bottom;
optional dark or light translucent background;
automatic text contrast;
safe margins;
preview at typical ebook thumbnail size.

However, avoid permanently writing text over an image without showing a preview. Some front images already contain a title.

Implementation choices:

SVG cover, containing the image and text.
Canvas-rendered PNG/JPEG.
Separate cover image plus XHTML title page.

I recommend:

generate an SVG internally;
optionally rasterize it for reader compatibility;
always create a separate semantic XHTML title page.

The cover editor should allow:

text alignment;
title position;
author position;
font size;
text colour;
overlay opacity;
image crop mode;
preview aspect ratio.

Do not depend on remote fonts. Use bundled open-licensed fonts or system-safe EPUB fonts.

European-language title styles

“Support all European languages” should not mean maintaining one hard-coded list of translations.

Instead use three mechanisms:

1. Word style identifiers

Word’s built-in heading style often has a stable internal style ID even when its displayed name is localized. Prefer the style ID and outline level over the visible style name whenever available.

2. Localized aliases

Provide aliases for common styles:

interface LocalizedStyleAlias {
language: string;
aliases: {
title: string[];
subtitle: string[];
heading1: string[];
heading2: string[];
caption: string[];
quote: string[];
};
}

Include EU and broadly European languages, for example:

Bulgarian
Croatian
Czech
Danish
Dutch
English
Estonian
Finnish
French
German
Greek
Hungarian
Irish
Italian
Latvian
Lithuanian
Maltese
Polish
Portuguese
Romanian
Slovak
Slovenian
Spanish
Swedish
Icelandic
Norwegian
Ukrainian
Welsh
Catalan
Basque
Galician
Serbian
Albanian
Macedonian
Turkish

But aliases should only be fallback evidence, not the primary classification method.

3. Structural and typographic inference

Use:

outline level;
style inheritance;
paragraph role;
font size;
boldness;
spacing before and after;
page position;
numbering;
frequency;
table-of-contents references;
whether the style occurs mostly as short paragraphs.

This is much more robust than language-specific name matching.

Inferring headings from styles and text sizes

Yes, but it should be an explicit analysis stage rather than an unconditional transformation.

Mammoth intentionally relies on semantic Word styles and generally ignores font size and visual formatting. Therefore, for your requested inference, WordConvert will probably need to inspect styles.xml and paragraph/run properties itself before or alongside Mammoth.

The analyzer should create a report such as:

Word style Uses Size Outline Proposed mapping Confidence
TitleCustom 1 28 pt — Title 0.98
HeadBlue 12 18 pt 0 Heading 1 0.99
SubHeadBlue 31 14 pt 1 Heading 2 0.99
EmphasisLarge 4 16 pt — Paragraph 0.45
Body Text 386 11 pt — Paragraph 0.99

The user can then edit the mapping before conversion.

Suggested classification precedence

1. Explicit user mapping
2. OOXML outline level
3. Built-in style ID
4. Table-of-contents relationship
5. Known localized style name
6. Style inheritance
7. Typographic and structural inference
8. Plain paragraph
   Font-size inference

Font size alone is not reliable. A pull quote, disclaimer or front-page author can be larger than a heading. Instead, calculate a style score:

headingScore =
outlineLevelWeight +
shortParagraphWeight +
fontSizeRankWeight +
boldWeight +
spacingBeforeWeight +
numberingWeight +
repeatedPatternWeight -
longParagraphPenalty -
captionPatternPenalty;

Rank font sizes relative to the document’s dominant body style rather than assigning fixed values:

Largest rare style → possible title
Next distinct tier → possible H1
Next tier → possible H2
Dominant style → body
Smaller styles → caption, footnote or metadata

The GUI should offer:

detected style table;
sample paragraphs for every style;
dropdown mapping;
confidence indicator;
“apply automatically above confidence threshold”;
save/load mapping presets;
export mapping as JSON.
Browser testing

Yes, Codex can use its own browser when working in an environment that provides Codex browser or computer-use capabilities. OpenAI documents both an in-app browser and computer-use functionality, and has specifically described Codex spinning up a browser to inspect and iterate on frontend work.

However, its internal browser should not replace repeatable automated tests.

Use:

Vitest for all conversion modules;
Codex browser for visual and exploratory checks;
your browsertools skill when available for repeatable application interaction and screenshots;
optionally a minimal browser-test framework only when CI needs automated interaction and browsertools is unavailable.

That avoids Playwright as a mandatory dependency while retaining testability.

I would write the requirement as:

Use Codex’s built-in browser for interactive UI testing. When the browsertools skill is available, use it for repeatable browser checks. Do not add Playwright unless neither facility can provide the required automated CI smoke tests.

A browser run should verify:

selecting a DOCX;
drag-and-drop;
style-mapping editor;
metadata editing;
HTML preview;
cover editor;
all output downloads;
responsive layout;
keyboard navigation;
dark mode;
no network requests during conversion.
