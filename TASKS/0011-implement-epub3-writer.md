# 0011 Implement EPUB 3 writer

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
Area: epub-writer
Depends on: 0003, 0004, 0007

## Context

Generate deterministic, reflowable, secure EPUB 3 publications from the semantic model.

## Acceptance Criteria

- EPUB has first/uncompressed `mimetype`, container, OPF, nav, XHTML chapters, styles, manifest, spine, assets, and title page.
- Chapters split primarily at H1 boundaries without splitting nested structures.
- Required identifier, title, language, and modified timestamp metadata are valid and injectable for deterministic tests.
- Output prohibits scripts, handlers, remote resources, unsafe SVG/URLs, iframes, and undeclared resources.
- Generated fixtures pass EPUBCheck locally and in the later CI workflow.

## Implementation Notes

- Reuse safe serialization primitives, not HTML document output, while sharing bounded escaping utilities.
- Document how deterministic ZIP timestamps/order interact with required EPUB modification metadata.

## Agent Notes

- Next step: create the smallest valid EPUB and gate each feature with EPUBCheck.
