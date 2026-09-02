# 0023 Harden and tune PDF formula OCR

Status: done
Priority: high
Subsystem: quality
Depends on: 0022

## Context

Tune formula detection and recognition against deterministic, application-like
fixtures, verify worker/runtime behavior in real browsers, and complete the
privacy, licensing, offline, performance, and deployment work needed to ship the
feature.

This phase closes the production definition of done. Thresholds and model
settings must be based on repository fixtures and measured evidence rather than
public benchmark claims or isolated happy paths.

## Acceptance Criteria

- `scripts/generate-pdf-fixtures.mjs` produces deterministic inline, display,
  mixed-layout, and false-positive formula PDFs, including prose, scripts,
  Greek/operators, a complex fraction, sum/integral, equation number, nearby
  figure, and representative two-column content where practical.
- Fixture expectations cover semantic inline/block equations, retained equation
  numbering, nearby figures, and false positives such as headings, code, prose,
  chemistry-like text, and numeric tables.
- A local benchmark corpus of 50-100 generated/licensable formula crops reports
  detection precision/recall, region IoU, normalized TeX exact/edit distance,
  KaTeX parse rate, initialization/inference time, and measurable memory data.
- Detection thresholds, crop scale/padding, and confidence policy are tuned from
  benchmark evidence and remain named constants with regression tests.
- Browser tests verify no model request for plain/simple-only PDFs, local model
  recognition for complex math, recoverable model failure, WebGPU where
  available, forced WASM fallback, cancellation, review/edit/reject flow,
  exported Markdown/HTML/EPUB semantics, and nonblank source/rendered previews.
- Model and formula assets work under `/word-convert/` and custom base paths,
  are same-origin, and are available through the intended offline caching model.
- Resource budgets are exercised with hostile candidate counts, crop sizes,
  token generation, cancellation, repeated conversions, and worker disposal;
  limits retain source and never crash whole-document conversion.
- README privacy/usage text states that PDF formula detection and recognition
  remain local. `documentation/hardening.md`, model asset documentation, and
  `THIRD_PARTY_NOTICES.md` record browser assumptions, budgets, origin, pinned
  revision, hashes, licence, attribution, and redistribution basis.
- A final code review prioritizes correctness, privacy, lifecycle leaks, warning
  routing, deterministic reruns, and missing tests; findings are fixed or
  documented before completion.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm fixtures:pdf`, `pnpm test:heron`, the focused formula-model check, and
  static build verification all pass.

## Implementation Notes

- Extend the fixture generator rather than adding arbitrary third-party PDFs.
- Normalize only harmless TeX differences in benchmark tests: whitespace,
  outer math delimiters, appropriate `\\left`/`\\right`, and demonstrably
  redundant braces. Do not implement semantic TeX simplification.
- Capture browser evidence in the existing documentation location and ensure
  temporary servers/processes are stopped after verification.
- Do not commit model weights until licence and redistribution checks are
  documented. Follow the existing Heron strategy if large weights are prepared
  outside normal source history.

## Agent Notes

- 2026-09-02 GitHub Copilot: Created from phase 4 of the PDF formula
  specification. This task is the shipping gate and should not be marked done
  from unit tests alone; real browser, asset, privacy, and lifecycle evidence is
  required.
- 2026-09-02 GitHub Copilot: Added deterministic formula-rich and deliberate
  false-positive PDFs plus a generated 60-crop recognition corpus. The measured
  Chromium 146 WebGPU run produced 48/60 strict KaTeX parses, 4 recoverable
  failures, 1/60 normalized exact TeX, 225.9 ms median and 498 ms p95 inference,
  178,952,787 transferred model bytes, and an 82,093,612-byte observed JS heap
  high-water mark. This evidence keeps ONNX output reviewable and simple text
  reconstruction preferred. Tightened the named detector threshold and rejected
  subordinate script fragments; the generated detector fixture now has 100%
  precision, 20% recall, and 0.895 IoU for its complete semantic result.
- 2026-09-02 GitHub Copilot: Verified a clean Chromium worker through sample and
  full PDF processing, same-origin model use, pointer/keyboard selection,
  recoverable recognition failure, and zero desktop/mobile overflow. Updated
  privacy, hardening, asset, benchmark, and browser evidence documentation. A
  correctness/privacy/lifecycle review found no unresolved shipping issue.
  Formatting, lint, all typechecks, 275 tests, production build, PDF fixture
  regeneration, real Heron, real RapidLatexOCR, and static offline verification
  pass. Firefox, Safari, and assistive-technology manual passes remain the
  documented human release matrix rather than claimed evidence.