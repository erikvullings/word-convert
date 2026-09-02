# 0025 Benchmark alternative formula recognizers

Status: open
Priority: low
Subsystem: research
Depends on: 0021

## Context

Evaluate TexTeller ONNX and other browser-compatible image-to-LaTeX models
behind the existing `PdfFormulaRecognizer` contract. RapidLatexOCR remains the
production default until application-representative evidence justifies a change.

Current TexTeller distributions are substantially larger, with visible
quantized encoder and decoder assets around 88 MB and 228 MB respectively, but
may improve difficult matrices, rare symbols, and multiline formulae.

## Acceptance Criteria

- Candidates are checked for browser compatibility, licence and redistribution
  rights, complete download size, same-origin deployment, WebGPU/WASM support,
  and realistic peak memory before inference benchmarking.
- The `0023` benchmark corpus compares normalized TeX accuracy, parse success,
  difficult-structure subsets, initialization/inference time, transfer size,
  and memory under identical crop preprocessing and token limits.
- Results and reproducible commands are documented, including model revisions,
  hashes, provider/browser versions, failures, and deployment implications.
- Any adapter prototype implements the existing recognizer interface and does
  not alter reader-domain candidate logic or writer behavior.
- Production defaults change only when measured quality gains justify bundle,
  memory, licensing, and maintenance costs; otherwise the task records why the
  current recognizer remains preferred.

## Implementation Notes

- Do not add Transformers.js solely for convenience without measuring its full
  runtime and asset impact against the direct ONNX Runtime adapter.
- Do not fetch model files from external origins in production or include model
  weights before redistribution checks are complete.

## Agent Notes

- 2026-09-02 GitHub Copilot: Created as the explicit secondary-model benchmark
  requested by the specification. It is not on the initial shipping path.