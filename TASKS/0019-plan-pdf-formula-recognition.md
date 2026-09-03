# 0019 Plan PDF formula recognition

Status: done
Priority: high
Subsystem: conversion
Depends on: 0018

## Context

Extend text-native PDF conversion with local formula detection and LaTeX
recognition. The design must reuse the existing PDF.js extraction, Heron layout
detection, neutral `DocumentModel` equation types, worker boundary, formula
writers, and review-oriented SPA workflow. It must not create a parallel PDF or
formula pipeline.

The implementation is split into independently testable phases because formula
detection, autoregressive ONNX inference, user decisions, and browser hardening
have different risks. Source PDFs, formula crops, and model inference remain in
the browser. Runtime model files must be pinned, same-origin assets.

## Acceptance Criteria

- The production work is divided into deterministic detection, ONNX recognition,
  formula review, and hardening tasks with explicit dependencies.
- Deferred manual region selection and recognizer comparison are tracked without
  expanding the first production implementation.
- Each implementation task identifies its architectural boundaries, tests, and
  security or resource constraints well enough for another agent to resume it.

## Implementation Notes

- `0020` owns reader-domain candidate detection, fusion, reconstruction, and
  generic equation provenance.
- `0021` owns crop recognition and the worker-side RapidLatexOCR ONNX adapter.
- `0022` owns deterministic review decisions and the Formula Review UI.
- `0023` owns representative fixtures, tuning, browser evidence, documentation,
  licensing, and complete quality gates.
- `0024` and `0025` are optional follow-ups and are not part of the initial
  production dependency chain.

## Agent Notes

- 2026-09-02 GitHub Copilot: Converted the supplied implementation specification
  into phased task files. The critical path is `0020` -> `0021` -> `0022` ->
  `0023`; manual region creation and alternative recognizer evaluation remain
  explicit follow-ups.
- 2026-09-03 GitHub Copilot: TexTeller q4 superseded the planned RapidLatexOCR
  production adapter after the `0025` comparison. The phase ownership above is
  retained as the historical implementation plan.
