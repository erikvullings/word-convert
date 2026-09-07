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
- Previous and next controls save the current part before switching, are
  keyboard accessible, and are disabled at the corresponding book boundary.
- Every action that leaves or restructures the current part, including preview,
  merge, and split, first applies the latest editor content to the in-memory
  semantic document model so no accepted edit is lost.
- Users can preview either the current part or the entire book. Both previews
  use the semantic HTML fragment renderer and the shared restrictive DOMPurify
  insertion policy.
- Users can merge the current part with an immediately adjacent part without
  losing content, assets, equations, notes, ordering, or semantic structure.
- With the cursor or selection on a level-two (`##`) heading, users can split
  the current part immediately before that heading. The selected heading starts
  the new adjacent part; invalid split locations are rejected with a clear
  editor notice.
- Book-level metadata and output settings remain unchanged while navigating,
  splitting, merging, and previewing parts, and final conversion still uses the
  complete reconstructed book.
- Focused tests cover part derivation, boundary navigation, autosave-before-
  switch, current-part versus whole-book preview, lossless adjacent merges,
  valid and invalid `##` splits, and preservation of book-level state.

## Implementation Notes

- Build part operations as pure transformations around
  `apps/web/src/content-editor.ts`, then wire them through
  `apps/web/src/state.ts`, `apps/web/src/controller.ts`, and
  `apps/web/src/app.ts`.
- Treat autosave as an in-memory commit to `DocumentModel`, not browser storage.
  Continue persisting only preferences and style-mapping presets; never persist
  source buffers, document content, generated output, filenames, or diagnostics.
- Keep part boundaries as editor workflow state over the semantic model rather
  than adding output-format-specific chapter objects. Final writers must receive
  the same complete `DocumentModel` contract.
- Reuse the HTML writer's fragment mode for both preview scopes, and sanitize
  only at the browser insertion boundary.

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
