# 0011 Implement EPUB 3 writer

Status: done
Priority: high
Owner: unassigned
Agent: codex
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
- 2026-07-15 codex: Implemented typed `writeEpub` output with deterministic stored-first `mimetype` ZIP packaging, container/OPF/nav/title page/styles, top-level H1 chapter splitting, semantic XHTML serialization, heading navigation, metadata overrides and validation, generated manifest-declared passive assets, notes, equations, and strict active/remote resource exclusion. Added six focused tests covering archive/metadata structure, nested split safety and navigation, semantic nodes/assets, hostile input and determinism, required metadata failures, and local EPUBCheck 5.3.0 validation. Verified the six focused tests, full workspace tests, package and workspace typechecks, zero-warning lint, formatting, production build, and `git diff --check`; no known limitations within this task's scope.
- 2026-07-15 codex: Integrated EPUB output and package-layout inspection into the web worker and reshaped the app into a responsive Document → Format → Preview → Download flow. HTML renders directly; Markdown offers sanitized rendered/source tabs through slimdown-js; style and metadata review are optional recovery actions. Fixed shared Materialized Select state by giving each style row its own keyed factory instance, replaced the three-way theme switcher with a label-free light/dark toggle, and limited EPUB configuration to EPUB output. Verified focused web tests, the full workspace suite, workspace typechecks, zero-warning lint, formatting, and the production build. Known limitation: the EPUB cover picker is presented but cover embedding is not yet implemented.
