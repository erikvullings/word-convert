# 0022 Build formula review workflow

Status: done
Priority: high
Subsystem: frontend
Depends on: 0021

## Context

Add a dedicated Formula Review editor for generic `DocumentModel` equations
created from PDF candidates. Users must compare recognized math with its PDF
source, inspect confidence/method/status, edit LaTeX with a safe live preview,
accept results, reset edits, and reject false positives before export.

The UI is not the semantic source of truth. Decisions are stored as typed PDF
analysis inputs and the final PDF model-construction phase is rerun
deterministically, analogous to existing cleanup decisions.

## Acceptance Criteria

- Formula Review appears only when equations are present and can be opened after
  PDF processing and from formula-related warnings.
- State/controller contracts cover selection, all/needs-review/edited/accepted
  filters, drafts, validation errors, accept, save edit, reset, reject,
  previous/next, and accepting all eligible high-confidence formulas.
- The list shows page, source thumbnail/region, safe KaTeX preview, current TeX,
  confidence band, recognition method, inline/block mode, review status, and
  parse/recognition warnings without relying on color alone.
- The detail editor shows the original PDF region, rendered formula, and an
  explicitly labelled LaTeX input. Safe KaTeX uses strict handling and
  `trust: false`; invalid drafts show an actionable error and are not saved.
- Saving an edit preserves original recognized TeX, changes recognition method
  to `user`, and survives analysis/model reruns. Reset restores the detected
  value; accept preserves semantics while recording review status.
- `Not a formula` stores a typed text decision and reruns model construction so
  the underlying source text/image is restored and no orphaned equation remains.
- Accepted/edited/rejected decisions survive unrelated cleanup and metadata
  reruns while decisions for genuinely disappeared candidates are discarded
  deterministically.
- Source previews reuse retained in-memory PDF bytes and normalized locations
  where possible; temporary canvases/object URLs are released. A bounded preview
  asset is allowed only if existing preview infrastructure cannot crop reliably.
- Warning destinations for formula recognition, confidence, invalid TeX, and
  limits focus Formula Review rather than output formula-mode settings.
- Desktop and narrow layouts are usable; tab navigation, button labels, source
  image alt text, screen-reader math, previous/next controls, and optional
  Cmd/Ctrl+Enter and Escape behavior are covered.
- UI/controller tests cover conditional visibility, selection/filtering, live
  preview validation, save/reset/reject reruns, bulk acceptance eligibility, and
  warning navigation.

## Implementation Notes

- Inspect style, metadata, PDF cleanup, and content editor patterns before adding
  new state. Prefer a focused `formula-review.ts` when it keeps `editors.ts`
  comprehensible.
- Recognition and output mode are separate concerns: edits affect semantic
  equation content; Markdown/HTML/EPUB settings decide how that content renders.
- Do not persist source PDF buffers, formula crops, models, or decisions outside
  the existing structured-clone-safe in-memory workflow and allowed presets.
- Manual selection of missed formula regions is not required here; it is tracked
  by `0024`.

## Agent Notes

- 2026-09-02 GitHub Copilot: Created from phase 3 of the PDF formula
  specification. Begin at the existing rerunnable PDF cleanup decision flow and
  warning routing, then add tests for decision persistence before visual UI work.
- 2026-09-02 GitHub Copilot: Added the dedicated Formula Review editor with
  typed in-memory decisions, filters, source-region comparison, strict KaTeX
  previews, edit/reset/reject/accept commands, keyboard controls, warning
  navigation, and responsive layouts. PDF analysis reruns preserve decisions
  during partial analyses and deterministically prune disappeared candidates and
  their UI state only after complete analyses. Focused controller, UI, reader,
  and type checks pass; the production component was also mounted in the live
  Vite app at desktop and narrow viewports with no console errors or overflow.
