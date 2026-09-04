# WordConvert tasks

## Foundation

- [x] 0001 Plan WordConvert architecture
- [x] 0002 Bootstrap workspace tooling
- [x] 0003 Define model and core contracts
- [x] 0004 Build DOCX fixture corpus

## Core conversion

- [x] 0005 Implement secure DOCX reader
- [x] 0006 Analyze styles headings and metadata
- [x] 0007 Implement HTML writer
- [x] 0008 Implement Markdown writer
- [x] 0011 Implement EPUB 3 writer
- [x] 0013 Implement formula pipeline

## Application workflow

- [x] 0009 Build SPA shell and worker
- [x] 0010 Build style and metadata editors
- [x] 0012 Build cover generator and editor
- [x] 0014 Complete preview and output workflow

## Release

- [x] 0015 Harden and browser test
- [x] 0016 Write documentation and licensing
- [x] 0017 Add CI and Pages deployment

## Format expansion

- [x] 0018 Add PDF import support

## PDF formula recognition

The production path is sequential: deterministic reader semantics first, then
local model inference, review decisions, and browser hardening.

- [x] 0019 Plan PDF formula recognition
- [x] 0020 Detect and reconstruct PDF formulas
- [x] 0021 Add local ONNX formula recognition *(needs 0020)*
- [x] 0022 Build formula review workflow *(needs 0021)*
- [x] 0023 Harden and tune PDF formula OCR *(needs 0022)*

## Formula follow-ups

These improvements are intentionally outside the initial production path.

- [x] 0024 Add manual PDF formula selection *(needs 0022)*
- [x] 0025 Benchmark alternative formula recognizers *(needs 0021)*

## Conversion follow-ups

- [x] 0026 Preserve optional DOCX ToC links
- [x] 0027 Add workflow routes
