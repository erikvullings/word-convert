# 0013 Implement formula pipeline

Status: open
Priority: medium
Owner: unassigned
Agent: unassigned
Area: math
Depends on: 0007, 0008, 0011

## Context

Convert extracted OMML into normalized math with source, MathML, KaTeX, and disabled output modes.

## Acceptance Criteria

- Parser supports inline/display formulas, fractions, roots, matrices, scripts, and Unicode symbols in required tests.
- Unsupported OMML retains safe diagnostic/source information and emits a warning instead of disappearing.
- KaTeX rendering uses safe options without trust features and bundles CSS/fonts locally when selected.
- Markdown, HTML, EPUB, and preview integrate formula modes with accessible fallback behavior.
- Malicious formula source and error paths cannot inject markup or active content.

## Implementation Notes

- Keep OMML normalization separate from MathML/TeX serialization and KaTeX rendering.
- Prefer EPUB MathML where practical, with explicit compatibility fallbacks.

## Agent Notes

- Next step: define the normalized math subset and unsupported-node representation.
