# 0021 Add local ONNX formula recognition

Status: open
Priority: high
Subsystem: conversion
Depends on: 0020

## Context

Recognize complex and display formula candidates as LaTeX in the conversion Web
Worker using pinned RapidLatexOCR/pix2tex-style ONNX assets. The PDF reader owns
the recognition contract and conversion policy; the web worker injects the
browser-specific ONNX Runtime implementation, following existing Heron runtime
and asset conventions.

The model is approximately 179 MB across resizer, encoder, decoder, and
tokenizer assets. It must be lazy-loaded only when full processing finds a
candidate that deterministic reconstruction cannot handle.

## Acceptance Criteria

- Final formula regions are rasterized at a tested 2x-3x logical scale with
  modest page-bounded padding, white compositing, capped dimensions, and prompt
  disposal of temporary pixel/canvas resources.
- A worker-side `PdfFormulaRecognizer` adapter runs image resizing, encoder, and
  autoregressive decoder inference with a bounded token count and normalized TeX
  output. No ONNX Runtime import enters `@wordconvert/pdf-reader`.
- Recognizer initialization is lazy and singleton-like per worker lifecycle.
  Ordinary PDFs and documents containing only simple deterministic inline math
  do not fetch or initialize formula model files.
- Runtime provider order is WebGPU followed by graceful WASM fallback, reusing
  Heron conventions where practical without coupling the two models.
- Cancellation is checked between formulas and during decoder generation where
  practical. Progress reports candidate detection, formula-level recognition,
  and document construction without token-level events.
- Initialization, inference, empty output, invalid or suspiciously long TeX,
  and limit failures issue targeted reviewable warnings while preserving source
  evidence and allowing the rest of the PDF conversion to finish.
- KaTeX parsing with strict safe settings validates recognized TeX. Detection
  confidence, recognizer diagnostics, parse success, and contamination evidence
  produce a review confidence band without presenting an uncalibrated number as
  a probability.
- Exact model revision, tokenizer, origin, licence, file sizes, and SHA-256
  hashes are recorded in a manifest. Runtime URLs are same-origin and work under
  the configured base path and offline cache policy.
- Adapter tests use fake sessions/assets in normal Vitest and cover lazy loading,
  provider fallback, decoder termination/token limits, cancellation, errors, and
  cleanup. A focused opt-in command verifies real model assets when installed.

## Implementation Notes

- Inspect `apps/web/src/worker/heron-layout-detector.ts` and its model tests
  before deciding shared runtime helpers and asset placement.
- Prefer `apps/web/src/worker/formula-recognizer.ts` unless current worker
  organization suggests a more local name.
- Do not download from Hugging Face or another CDN at runtime. Verify upstream
  redistribution rights before vendoring weights or adding a downloader.
- Keep recognition crops temporary; persistent source comparison should use PDF
  location data unless `0022` proves a bounded preview asset is necessary.
- Representative cleanup scans count candidates but never run expensive formula
  recognition.

## Agent Notes

- 2026-09-02 GitHub Copilot: Created from phase 2 of the PDF formula
  specification. RapidLatexOCR is the initial target; TexTeller remains behind
  the same interface and is tracked separately in `0025`.