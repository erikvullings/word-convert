# 0005 Implement secure DOCX reader

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
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
