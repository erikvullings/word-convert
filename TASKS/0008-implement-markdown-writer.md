# 0008 Implement Markdown writer

Status: done
Priority: high
Owner: erikvullings
Agent: codex
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
- 2026-07-15 codex: Implemented direct semantic-model Markdown generation in `@wordconvert/markdown-writer`, using GFM tables, strikethrough and footnotes; bounded inline HTML for underline/subscript/superscript; TeX-style math delimiters; deterministic data-URI and Markdown-plus-images ZIP modes; generated collision-free POSIX asset paths; contextual escaping and collision-free code fences; and typed deterministic warnings for unsafe, missing, or degraded constructs. Added seven focused tests covering the supported model surface, nested structures, notes/math/assets/captions, hostile input and exact warning order, code delimiter collisions, and deterministic ZIP asset collisions. Verified the seven focused tests, full 43-test workspace suite, recursive workspace typecheck, zero-warning lint, formatting, production build, and `git diff --check`; no known limitations within this task's scope.
