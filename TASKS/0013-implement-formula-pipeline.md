# 0013 Implement formula pipeline

Status: done
Priority: medium
Owner: erikvullings
Agent: codex
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
- 2026-07-16 codex: Implemented a typed normalized OMML subset with separate TeX/MathML serializers, safe KaTeX rendering, retained unsupported diagnostics, and deterministic reader warnings; integrated source, MathML, KaTeX, and disabled modes across HTML, Markdown, EPUB, the worker, and preview preferences, with EPUB defaulting to MathML and local embedded KaTeX CSS/font data. Added eight focused tests across the converter, DOCX extraction, and three writers covering inline/display equations, fractions, roots, matrices, scripts, Unicode, unsupported and malicious input, all formula modes, and accessible fallbacks. Verified those eight task tests through their five focused files, the full 102-test workspace suite, recursive strict typecheck, zero-warning lint, production build, and `git diff --check`. Known limitation: uncommon OMML outside the documented normalized subset deliberately degrades to a warning and safe diagnostic fallback.
