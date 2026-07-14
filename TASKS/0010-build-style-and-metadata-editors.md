# 0010 Build style and metadata editors

Status: open
Priority: high
Owner: unassigned
Agent: unassigned
Area: frontend
Depends on: 0009

## Context

Expose style analysis and metadata inference for verification and correction before conversion.

## Acceptance Criteria

- Style table shows proposals, confidence, reasons, samples, formatting, and all mapping choices.
- Users can accept high-confidence mappings, edit mappings, rerun conversion, and save/import/export JSON presets safely.
- Metadata editor supports every required field, structured multiple authors, distinct dates, provenance, confidence, and default markers.
- Editors are keyboard accessible, responsive, and retain edits while moving between workflow stages.

## Implementation Notes

- Validate imported presets against a versioned schema and never treat their text as trusted markup.

## Agent Notes

- Next step: build editors against fixture analysis results and test state transitions as pure functions.
