# 0005 Implement secure DOCX reader

Status: done
Priority: high
Owner: erikvullings
Agent: codex
Area: docx-reader
Depends on: 0003, 0004

## Context

Inspect OOXML directly and convert safe, unencrypted DOCX packages into the neutral model without browser dependencies.

## Acceptance Criteria

- Reader validates package type and rejects legacy DOC, encrypted, macro-enabled, malformed, and over-limit input clearly.
- ZIP/XML processing enforces configurable limits and rejects traversal, entity expansion, and unsafe resources.
- Reader processes document content, relationships, numbering, media, properties, notes, styles, language, headers/footers, and OMML extraction.
- Main content preserves supported paragraphs, runs, links, lists, tables, notes, images, and provenance.
- Decorative furniture is excluded by default and reported as warnings.

## Implementation Notes

- Do not log filenames, text, metadata, images, or formula contents.
- Keep the implementation behind `DocxReader`; use Mammoth only if it adds value without becoming the semantic source of truth.

## Agent Notes

- Next step: implement package validation and minimal document parsing test-first, then expand constructs.
- 2026-07-14: Started implementation. The reader will inspect ZIP central-directory metadata before decompression, reject active/remote content and XML declarations that can define entities, and parse OOXML into the existing dependency-free model. Tests use the deterministic 0004 corpus and on-demand limit fixtures.
- 2026-07-14: Completed `secureDocxReader` in `packages/docx-reader/src/`: browser-compatible ZIP inspection enforces compressed/expanded size, entry-count, encryption, path, and compression-ratio rules before extraction; the strict XML parser rejects DTD/entity declarations; package validation rejects legacy, malformed, macro-enabled, active-media, remote-resource, and unsafe-link inputs. OOXML parsing now covers metadata, styles, relationships, numbering/nested lists, paragraphs/runs/marks, links, tables, notes, images, tracked changes, language metadata, and lossless OMML extraction. Headers, footers, comments, and tracked deletions are deliberately omitted with warnings. The corpus-backed suite includes encrypted input and all hostile fixtures. Verified 22 tests plus workspace typecheck, lint, format check, production build, and `git diff --check`.
