# 0048 Preserve large body images and rasterize EPUB covers

Status: completed
Priority: high
Subsystem: conversion
Depends on: none

## Context

WordConvert 0.1.5 omits body images around 330 kB despite the default 1600 px
image cap. A 1400×1800 JPEG produces no EPUB image entry once its bytes cross
the threshold. CLI-supplied covers are emitted as `cover.svg`, which is not
accepted by the downstream EPUB workflow that needs a raster cover.

## Acceptance Criteria

- HTML/Markdown input preserves a valid body image above the reported size
  threshold in the EPUB manifest and chapter content.
- CLI-generated EPUB covers use a raster media type with a `cover-image`
  manifest declaration and preserve the semantic XHTML title page.
- Add regression tests for the image-size boundary and the CLI cover output.

## Implementation Notes

- Keep image composition in the text reader separate from Markdown tokenization;
  avoid placing large data URIs in parser destinations.
- Keep core cover generation browser-independent and inject rasterization from
  the CLI native runtime.

## Agent Notes

- 2026-11-15 Copilot: Reproduced the body-image cliff with 1400×1800 JPEGs:
  316,097 bytes yields one EPUB image entry, while 342,660 bytes yields none.
  The text reader model has no asset for the larger image; the Marked lexer
  tokenizes its data URI as a link rather than an image. The EPUB writer and
  image resizer are downstream and do not receive it.
- 2026-11-15 Copilot: Text-reader images now import directly from the collected
  data URIs and use short Markdown aliases, avoiding large parser destinations.
  A Bun-driven CLI regression covers 1400×1800 JPEGs in both HTML and Markdown
  and verifies manifest and chapter references. The EPUB writer accepts an
  injected cover rasterizer; the CLI uses its native canvas adapter for
  source/generated/file covers, emits PNG, and retains the semantic title page.
  Focused tests, workspace typecheck, and 10 consecutive full-suite runs passed.
