# 0006 Analyze styles headings and metadata

Status: done
Priority: high
Owner: erikvullings
Agent: codex
Area: analysis
Depends on: 0005

## Context

Analyze styles and metadata candidates before final model conversion, with transparent proposals users can override.

## Acceptance Criteria

- Every used paragraph and character style has effective formatting, inheritance, usage examples, proposed mapping, confidence, and reasons.
- Heading classification follows the exact precedence in `REQUIREMENTS.md` and never relies on font size alone.
- Localized aliases cover the specified European languages as fallback evidence.
- Metadata candidates follow source priority and preserve confidence/provenance, multiple structured authors, and distinct dates.
- Explicit mappings and presets can be applied deterministically to rerun model generation.

## Implementation Notes

- Separate raw analysis, proposal scoring, user overrides, and final model construction.
- Test ambiguous styles and negative cases, not only obvious headings.

## Agent Notes

- Next step: formalize scoring features and confidence calibration using the fixture corpus.
- 2026-07-15 codex: Added typed raw style/usage and metadata-candidate analysis in `@wordconvert/docx-reader`, including inherited effective formatting, usage examples, exact heading-evidence precedence, European localized alias fallback, confidence/reasons, structured author and distinct-date resolution, deterministic presets/explicit overrides, and delayed final block construction. Integrated analysis into the secure reader and documented the public rerun surface. Added 10 task-specific tests (7 analyzer tests and 3 reader integration/negative tests); verified the focused files, full 32-test workspace suite, all workspace typechecks, zero-warning lint, formatting, production build, and `git diff --check`. Known limitation: confidence calibration remains heuristic and should be tuned against a larger real-world corpus.
