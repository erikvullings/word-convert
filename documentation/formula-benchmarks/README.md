# PDF formula benchmark

Measured 2 September 2026 on Chromium 146 for macOS with WebGPU enabled. The
committed corpus contains 60 generated, tightly bounded SVG crops across inline,
scripts, Greek, operators, relations, fractions, roots, matrices, multiline,
rare-symbol, and equation-number categories. The generator records dimensions
and expected TeX; no third-party document or formula image is redistributed.

## Reproduce

```sh
pnpm benchmark:formula:generate
# Download a pinned TexTeller q4 encoder, decoder, and tokenizer to a local
# directory, then start Vite with that directory exposed only to development.
WORDCONVERT_TEXTELLER_MODEL_DIR=/path/to/texteller-q4 pnpm dev --port 5191
WORDCONVERT_TEXTELLER_MODEL_DIR=/path/to/texteller-q4 \
WORDCONVERT_CDP_URL=http://localhost:9222 \
WORDCONVERT_BENCHMARK_URL=http://127.0.0.1:5191/ \
  pnpm benchmark:formula:run
pnpm benchmark:formula:report
```

The runner loads the production TexTeller adapter and pinned local assets, uses
tight crop pixels, caps generation at 128
tokens, and records the browser, WebGPU availability, initialization time,
per-case inference time, transfer bytes, and JavaScript heap high-water mark.
The report normalizes only whitespace, outer math delimiters, `\\left`/`\\right`,
and redundant single-token braces. Raw results and the derived report are
committed beside this file.

## Detection fixture

The generated two-page PDF has five semantic ground-truth equations and the
paired false-positive PDF contains headings, code, prose, chemistry-like text,
and a numeric table. The deterministic text detector currently finds one
complete semantic equation: precision 1/1 (100%), recall 1/5 (20%), and region
IoU 0.895 against its conservative generated ground-truth box. The incomplete
summation subscript `i=1` is explicitly rejected. Complex fraction, sum/integral,
and prose-embedded formulas rely on learned/manual regions or retained source,
so low deterministic recall is preferable to replacing prose with partial math.

## TexTeller results

The browser-tagged `onnx-community/TexTeller-ONNX` repository is pinned at
revision `9727784d91d7f8437dc7140941c4335284ce075e` and declares Apache-2.0.
Direct ONNX Runtime Web inference avoids the rejected Transformers.js/native
dependency path. The q4 pair used for the measured run is:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `onnx/encoder_model_q4.onnx` | 56,848,921 | `de5fe45294a00f45af907b783f3f4764dbdc95386676f4e20175d912cfe8e59a` |
| `onnx/decoder_model_q4.onnx` | 198,619,422 | `d937474a36f212cd704acc811b9eef32405f3aa20c5da812d7bf227abbc6004b` |
| `tokenizer.json` | 1,370,259 | `ec4ca954798a092faf6fefcfa47fb5f85d76cdf6ab170b624ae1a683d53dae14` |

Measured on the same Chromium 146 session and 60 generated crops:

| Measure | TexTeller q4 |
| --- | ---: |
| Strict KaTeX parse success | 48/60 (80%) |
| Recoverable inference failures | 0/60 (0%) |
| Normalized exact TeX | 7/60 (11.7%) |
| Mean normalized edit distance | 0.611 |
| Initialization | 3,024.0 ms |
| Median inference | 322.0 ms |
| p95 inference | 595.8 ms |
| Model transfer | 256,838,602 bytes |
| Observed peak JS heap | 226,651,669 bytes |

TexTeller q4 was materially closer to the expected TeX, emitted no bounded
inference failures, and correctly recognized all basic script examples. It
still dropped the second row in every generated multiline example, represented
several visual fractions as slash division, and produced only five parseable
matrix outputs. Raw results and the derived report are committed beside this
file.

The smaller q4f16 pair (49,751,260-byte encoder and 152,177,706-byte decoder)
loaded successfully but was not usable: both BOS `0` and the nested TrOCR
`decoder_start_token_id` `2` produced a single repeated token for all 128 decode
steps. The q4 model emitted EOS normally with the same adapter and input, which
isolates the failure to q4f16 execution rather than tokenization or crop
preprocessing.

TexTeller is the sole formula recognizer. Its one-time download is substantial,
and conversion is slower when recognition is needed, so users can disable it or
clear its cached same-origin assets from the home screen. No source crop or TeX
is sent to a service.
