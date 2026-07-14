# 0008 Implement Markdown writer

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
Area: markdown-writer
Depends on: 0003, 0005

## Context

Generate Markdown directly from the semantic model in both requested packaging modes.

## Acceptance Criteria

- Writer preserves supported headings, formatting, links, nested lists, quotes, code, tables, notes, images, captions, and math.
- Output supports a Markdown-plus-images ZIP and a single Markdown file with data-URI images.
- Asset names are deterministic and safe, paths are relative POSIX paths, and collisions are tested.
- Escaping and unsupported-node warnings are precise and deterministic.

## Implementation Notes

- Use Turndown only for bounded HTML fragments where appropriate; do not turn the model into HTML first.

## Agent Notes

- Next step: define Markdown flavor decisions and golden structural assertions.
