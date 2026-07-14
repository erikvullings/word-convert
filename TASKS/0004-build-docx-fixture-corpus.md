# 0004 Build DOCX fixture corpus

Status: done
Priority: high
Owner: erikvullings
Agent: codex
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
- 2026-07-14: Started implementation. The corpus will use a dependency-free Node generator with deterministic ZIP metadata, small committed fixtures and JSON structural manifests. Oversized entry-count and expanded-size limit cases will remain generated on demand.
- 2026-07-14: Completed `scripts/generate-docx-fixtures.mjs`, the committed synthetic corpus and per-file structural manifests under `tests/fixtures/docx/`, and `tests/fixtures.test.ts`. The comprehensive fixture covers document structures, metadata, media, notes, revisions, page furniture, Unicode/RTL, and OMML; focused fixtures cover localized styles, visual heading inference, malformed/traversal/compression limits, unsafe links, active SVG, unsafe XML, and macro content. Entry-count and expanded-size fixtures are generated on demand to keep Git small. Verified byte-for-byte regeneration, ZIP integrity, workspace tests, typecheck, lint, formatting, and production build.
