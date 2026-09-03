# 0024 Add manual PDF formula selection

Status: done
Priority: low
Subsystem: frontend
Depends on: 0022

## Context

Allow users to correct missed detections by selecting a region in the retained
PDF preview and marking it as a formula. This is a follow-up to the initial
review workflow and must not be approximated with a fragile or inaccessible
selection interaction.

## Acceptance Criteria

- A keyboard- and pointer-accessible PDF preview interaction creates normalized,
  page-bounded formula regions without mutating rendered output directly.
- User-created regions receive stable candidate IDs and typed formula decisions,
  can use deterministic reconstruction or local recognition, and enter the same
  Formula Review workflow as detected candidates.
- Regions survive deterministic reruns when their source page remains present
  and can be removed or marked as text without orphaning equations/assets.
- Limits, cancellation, warning behavior, privacy, and temporary preview/crop
  cleanup match automatically detected formulas.
- Controller, UI, reader integration, and browser tests cover selection,
  recognition, review, rerun persistence, rejection, and accessibility.

## Implementation Notes

- Reuse the normalized PDF source-location and decision contracts from `0020`
  and `0022`; do not introduce UI-owned equation nodes.
- Keep this follow-up independent of the `0023` production gate unless product
  scope is explicitly expanded.

## Agent Notes

- 2026-09-02 GitHub Copilot: Deferred from the initial implementation because a
  robust region-selection interaction is materially larger than editing and
  rejecting detected formulas.
- 2026-09-02 GitHub Copilot: Added normalized pointer and percentage-field
  selection, stable coordinate-derived manual IDs, inline/block choice, and
  removal through reader-owned candidates and typed decisions. Manual regions
  now traverse the existing deterministic reconstruction/OCR, limits, warning,
  review, rerun, reject, and cleanup paths. Fully analysed PDFs expose Formula
  Review even with zero automatic detections. Unit/controller/reader coverage
  includes image-only bounded recognition and crop disposal; live Chromium
  evidence covers pointer, keyboard, empty-review routing, recoverable failure,
  and responsive layout.
