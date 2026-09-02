# PDF formula benchmark

Measured 2 September 2026 on Chromium 146 for macOS with WebGPU enabled. The
committed corpus contains 60 generated, tightly bounded SVG crops across inline,
scripts, Greek, operators, relations, fractions, roots, matrices, multiline,
rare-symbol, and equation-number categories. The generator records dimensions
and expected TeX; no third-party document or formula image is redistributed.

## Reproduce

```sh
pnpm benchmark:formula:generate
# Start the Vite app on 127.0.0.1:5191 and Chromium with CDP on localhost:9222.
WORDCONVERT_CDP_URL=http://localhost:9222 \
WORDCONVERT_BENCHMARK_URL=http://127.0.0.1:5191/ \
  pnpm benchmark:formula:run
pnpm benchmark:formula:report
```

The runner loads the production RapidLatexOCR adapter and pinned local assets,
uses the same tight crop pixels for every recognizer, caps generation at 128
tokens, and records the browser, WebGPU availability, initialization time,
per-case inference time, transfer bytes, and JavaScript heap high-water mark.
The report normalizes only whitespace, outer math delimiters, `\\left`/`\\right`,
and redundant single-token braces. Raw results and the derived report are
committed beside this file.

## RapidLatexOCR results

| Measure | Result |
| --- | ---: |
| Cases | 60 |
| Strict KaTeX parse success | 48/60 (80%) |
| Recoverable inference failures | 4/60 (6.7%) |
| Normalized exact TeX | 1/60 (1.7%) |
| Mean normalized edit distance | 2.532 |
| Initialization | 782.8 ms |
| Median inference | 225.9 ms |
| p95 inference | 498.0 ms |
| Model transfer | 178,952,787 bytes |
| Observed peak JS heap | 82,093,612 bytes |

Matrices were weakest: two of six parsed and three failed. Fractions parsed in
four of six cases. These results do not justify accepting OCR output without
review. Deterministic reconstruction remains preferred for simple formulas;
recognized formulas remain reviewable, and failures retain source text.

## Detection fixture

The generated two-page PDF has five semantic ground-truth equations and the
paired false-positive PDF contains headings, code, prose, chemistry-like text,
and a numeric table. The deterministic text detector currently finds one
complete semantic equation: precision 1/1 (100%), recall 1/5 (20%), and region
IoU 0.895 against its conservative generated ground-truth box. The incomplete
summation subscript `i=1` is explicitly rejected. Complex fraction, sum/integral,
and prose-embedded formulas rely on learned/manual regions or retained source,
so low deterministic recall is preferable to replacing prose with partial math.

## TexTeller preflight

The browser-tagged `onnx-community/TexTeller-ONNX` repository is pinned at
revision `9727784d91d7f8437dc7140941c4335284ce075e` and declares Apache-2.0.
The smallest complete q4f16 pair is:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `onnx/encoder_model_q4f16.onnx` | 49,751,260 | `c42190515ffcd4a728a1abee4dc8d4636b62f782fd823294d2861434a7f7d0eb` |
| `onnx/decoder_model_q4f16.onnx` | 152,177,706 | `edebc490596d13313382eecfeef89f0041efe7bfa4e89391d5b5dbabab25100` |

Tokenizer and configuration files add approximately 2.24 MB. Official
unquantized encoder/decoder pairs exceed 1.18 GB. A temporary Transformers.js
3.8.1 installation occupied 360 MB before model weights: 47 MB Transformers.js,
90 MB alternate ONNX Runtime Web, 208 MB ONNX Runtime Node, and 15 MB libvips.
It also introduced blocked native `onnxruntime-node` and `sharp` build scripts,
which violates this repository's dependency policy.

The dependency was removed and no model weights were downloaded. The injected
research adapter still proves the `PdfFormulaRecognizer` contract, cancellation,
TeX validation, token cap, and disposal. Because preflight failed the practical
runtime, maintenance, and supply-chain gates, no accuracy or timing comparison
is claimed. RapidLatexOCR remains the production default; a future direct ONNX
Runtime Web adapter may rerun this corpus if it avoids those costs and can bound
peak WebGPU/WASM memory.
