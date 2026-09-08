# 0028 Add part-based book editor

Status: done
Priority: medium
Owner: unassigned
Agent: GitHub Copilot
Subsystem: frontend
Depends on: 0014

## Context

Editing the converted book as one Markdown document becomes cumbersome for long
books. Split the editing experience into an ordered set of chapters or parts so
users can focus on a manageable section while retaining whole-book previews and
output.

Book-level metadata and output configuration already survive workflow stage
changes and are outside this task. Part navigation and structural edits must not
reset or duplicate that state.

## Acceptance Criteria

- The content editor presents one ordered chapter or part at a time and clearly
  identifies the current part and its position in the book.
- The part editor uses the same first/previous/next/last pager pattern as the
  PDF preview. Navigation saves the current part before switching, is keyboard
  accessible, and is disabled at the corresponding book boundary.
- The original PDF and active-part editor remain side by side at equal viewport
  heights, with independent scrolling and aligned pagination.
- Edit mode stays focused on one practical part at a time. It does not expose
  separate preview, manual merge, or manual split controls; undersized parts are
  folded into an adjacent part automatically. The active-part editor can switch
  between WYSIWYG and Markdown modes.
- The full-book Markdown tab remains editable, uses the regular Markdown
  editor with Markdown/WYSIWYG switching, and masks base64 image payloads
  without discarding their underlying data.
- Markdown images inserted as validated base64 raster data are retained in the
  semantic document model and final EPUB.
- A part can be deleted after confirmation, except when it is the only
  remaining part.
- Markdown line breaks remain line breaks in Edit mode instead of becoming
  separate paragraphs.
- Page-break markers remain semantic during editing without displaying their
  Markdown comments in part view, and isolated OCR punctuation at page
  boundaries is discarded.
- Book-level metadata and output settings remain unchanged while navigating,
  deleting, and editing parts, and final conversion still uses the complete
  reconstructed book.
- Focused tests cover practical part derivation, pager navigation,
  autosave-before-switch, base64 image ingestion, line-break preservation,
  deletion, and preservation of book-level state.

## Implementation Notes

- Build part derivation and save operations as pure transformations around
  `apps/web/src/content-editor.ts`, then wire them through
  `apps/web/src/state.ts`, `apps/web/src/controller.ts`, and
  `apps/web/src/app.ts`.
- Treat autosave as an in-memory commit to `DocumentModel`, not browser storage.
  Continue persisting only preferences and style-mapping presets; never persist
  source buffers, document content, generated output, filenames, or diagnostics.
- Keep part boundaries as editor workflow state over the semantic model rather
  than adding output-format-specific chapter objects. Final writers must receive
  the same complete `DocumentModel` contract.
- Keep the PDF.js worker and decoder assets on stable, base-path-safe,
  application-owned URLs so original-page previews survive Vite dependency
  re-optimization and work in static builds.

## Agent Notes

- 2026-09-07 GitHub Copilot: Created from the requested long-book editing UX.
  Existing single-document editing is centered in
  `apps/web/src/content-editor.ts`, with draft state and actions in `state.ts`
  and `controller.ts`, and preview/editor rendering in `app.ts`. Preserve the
  existing book-level metadata and output configuration; the next step is to
  define pure, lossless part-boundary transformations and their tests.
- 2026-09-07 GitHub Copilot: Started implementation. Autosave is interpreted as
  committing the active draft to the in-memory `DocumentModel` before any
  navigation or structural action; document content remains intentionally
  excluded from browser persistence.
- 2026-09-07 GitHub Copilot: Completed the part-based editor with autosaving
  previous/next navigation, current-part and whole-book previews, adjacent
  merges, and level-two heading splits. Semantic reconciliation preserves
  document assets, equations, notes, styles, and caption boundaries, while
  unsupported external images block navigation instead of being discarded.
  Restored a dedicated EPUB cover tab, system-aware editor theming, and
  on-demand first-page PDF cover rasterization. Focused and full tests,
  typechecking, linting, production build, and static offline verification pass.
- 2026-09-07 GitHub Copilot: Addressed inspection feedback by automatically
  selecting PDF page 1 as the initial cover, restoring a full-book WYSIWYG
  editor, making the Markdown view editable, folding parts smaller than three
  visible blocks into an adjacent part, rejecting undersized splits, and adding
  confirmed part deletion.
- 2026-09-08 GitHub Copilot: Fixed blank previews and covers for scanned PDFs
  that use JPEG 2000 images or JBIG2 masks. PDF.js now loads bundled,
  same-origin OpenJPEG, JBIG2, and QCMS decoders under the configured
  application base path, including offline precaching and JavaScript fallbacks.
- 2026-09-08 GitHub Copilot: Repaired EPUB editing for semantic Markdown that
  contains inline HTML by passing rendered block markup to the part WYSIWYG
  editor and keeping the full-book Markdown view as a literal editable source.
  Replaced the mode radios with accessible tabs, removed the duplicate full-text
  mode, moved EPUB guidance below the workspace, and upgraded the Markdown
  dependencies.
- 2026-09-08 GitHub Copilot: Replaced the raw full-book Markdown textarea with
  the regular Markdown editor, masked base64 payloads, and imported
  signature-checked raster data URIs into semantic assets with bounded resource
  limits.
- 2026-09-08 GitHub Copilot: Simplified Edit mode to per-part editing,
  deletion, and a shared first/previous/next/last pager. Removed manual preview,
  merge, and split controls, matched editor and PDF viewport heights, and moved
  PDF.js workers to a stable application-owned URL.
- 2026-09-08 GitHub Copilot: Restored complete poem editing by deriving
  practical parts from both level-one book headings and level-two poem
  headings, while continuing to fold sections smaller than three visible
  lines into an adjacent part.
- 2026-09-08 GitHub Copilot: Corrected line-break handling so two-space
  Markdown breaks remain editable line breaks instead of becoming paragraphs.
  Aligned the original PDF and part-editor viewports, rendered CommonMark
  punctuation escapes without visible slashes, and removed isolated OCR
  backslash noise at PDF page boundaries.
- 2026-09-08 GitHub Copilot: Restored Markdown/WYSIWYG switching in the
  full-book editor, increased the aligned PDF and part-editor viewports, kept
  page-break markers semantic but invisible in part prose, and removed isolated
  `**` OCR artifacts immediately before page boundaries.
- 2026-09-08 GitHub Copilot: Restored the same Markdown/WYSIWYG mode tabs in
  the active-part Edit editor; the earlier repair had only restored them in the
  full-book Markdown tab.
