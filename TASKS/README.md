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
- [x] 0028 Refine backend-free EPUB sharing
- [x] 0029 Add part-based book editor *(needs 0014)*

## Command-line distribution

- [x] 0030 Add portable CLI and release bundles

## calibre-inspired PDF to EPUB conversion

Adopting the useful parts of calibre's `ebook-convert` transform stage. 0031 holds the
option-by-option gap map, accepted features, and deliberate rejections; the decision record
is closed, while implementation status remains tracked in the individual tasks. The other
hard sequences are 0033 → 0034 and 0036 → 0037. 0044 is the recommended first slice because
the heuristic tasks need stage-level before/after evidence, and calibre (GPLv3) stays an
offline comparison command only. 0045 (PDF tables) was added later at the user's request
and reverses one of 0031's rejections; it shares no sequence with the other subtasks.

- [x] 0031 Adopt calibre-inspired PDF to EPUB conversion stages *(epic)*
- [x] 0032 Expose PDF crop furniture and image options in the CLI
- [x] 0033 Add median-length driven PDF line unwrapping with a tunable factor
- [x] 0034 Add document-wide PDF de-hyphenation *(needs 0033)*
- [x] 0035 Normalize PDF indents and remove fake page margins
- [x] 0036 Add configurable chapter detection marking and heading-run merging *(needs 0033)*
- [x] 0037 Build hierarchical filtered tables of contents for PDF books *(needs 0036)*
- [x] 0038 Add scene break blank paragraph and punctuation normalization
- [x] 0039 Add bounded user pattern rules for furniture and text cleanup
- [x] 0040 Complete publication metadata and add CLI overrides with a sidecar file
- [x] 0041 Split oversized EPUB chapters by content size
- [ ] 0042 Add EPUB styling cover and navigation landmark output options *(cover: source needs 0043)*
- [x] 0043 Extract PDF image alt text captions and cover candidates
- [x] 0044 Add conversion pipeline stage dumps and verbosity levels
- [x] 0045 Detect PDF tables and emit TableNode *(added on request; not a calibre feature)*
- [x] 0047 Keep structured PDF tables over learned picture regions *(preserves
  tables with default CLI layout analysis enabled)*

## Test reliability

- [ ] 0046 Fix flaky CLI test timeouts under full suite load *(blocks trusting a
  red `pnpm test`; seen while implementing 0045, unrelated to it)*
