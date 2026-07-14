# 0006 Analyze styles headings and metadata

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
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
