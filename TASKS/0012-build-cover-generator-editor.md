# 0012 Build cover generator and editor

Status: open
Priority: medium
Owner: unassigned
Agent: unassigned
Area: cover
Depends on: 0009, 0011

## Context

Support uploaded, extracted, generated, and omitted EPUB covers with deterministic composition and live editing.

## Acceptance Criteria

- Core generator creates deterministic SVG compositions for all required cover layouts without browser globals.
- Inputs enforce image limits and sanitize SVG; rasterization is isolated behind a browser adapter where required.
- Editor controls crop, alignment, positions, sizes, text color, contrast panel, opacity, margins, and preview.
- UI warns about likely existing title text and always generates a semantic XHTML title page.
- EPUB declarations and cover assets pass EPUBCheck.

## Implementation Notes

- Use system-safe or bundled open-licensed fonts only; no remote font loading.
- Treat title-text detection as a conservative heuristic with an explainable warning.

## Agent Notes

- Next step: specify composition coordinates/options as serializable data before UI controls.
