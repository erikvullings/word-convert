# 0004 Build DOCX fixture corpus

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
Area: testing
Depends on: 0003

## Context

Create reproducible valid, edge-case, localized, mathematical, and hostile DOCX fixtures required for precise core tests.

## Acceptance Criteria

- A deterministic fixture generator and committed representative fixtures cover every category in `REQUIREMENTS.md`.
- Fixtures include expected structural manifests without embedding private or copyrighted documents.
- Malformed ZIP, traversal, compression-ratio, entry-count, expanded-size, unsafe-link, SVG, and XML cases are included.
- Fixtures cover European style aliases, Unicode, RTL, tracked changes, comments, notes, headers/footers, images, and OMML.

## Implementation Notes

- Prefer small generated OOXML packages whose intent is obvious in tests.
- Keep exceptionally large security fixtures generated on demand.

## Agent Notes

- Next step: create a fixture matrix mapping requirements to files and assertions.
