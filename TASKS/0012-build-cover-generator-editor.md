# 0012 Build cover generator and editor

Status: done
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
- 2026-07-16 codex: Implemented a strictly typed, serializable cover model and deterministic browser-independent SVG generator for image-only, overlay, title-panel, separate-title-page, and typographic layouts; bounded raster input to 10 MiB/40 MP, sanitized SVG, added a browser-only PNG rasterizer adapter, and provided a conservative explainable title-text filename heuristic. Built the EPUB cover editor for omitted, uploaded, extracted, and generated covers with crop, alignment, positions, sizes, text colour, contrast panel/opacity, image opacity, safe margins, aspect ratio, and live preview. Integrated manifest-declared cover SVG/XHTML assets while retaining the semantic XHTML title page. Added 9 focused tests across generator, editor model/UI, and EPUB integration; verified those files, EPUBCheck, the full workspace suite, recursive typechecks, zero-warning lint, task-file formatting, production build, `git diff --check`, and local browser shell checks with no console warnings. The workspace-wide Prettier check remains blocked by pre-existing formatting in untouched `packages/docx-reader/src/analysis.ts`; every file changed for this task passes Prettier. Known limitation: the heuristic intentionally uses filenames only and warns only when at least two significant title words are available; rasterization is available for callers but EPUB output prefers the validated SVG cover path.
