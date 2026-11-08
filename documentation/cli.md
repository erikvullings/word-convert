# Local command-line conversion

WordConvert's CLI shares the SPA's semantic readers and writers instead of
maintaining a separate conversion engine. It accepts **local DOCX and PDF**
files and produces standalone HTML, HTML ZIP, Markdown, Markdown ZIP, or EPUB.
Remote imports, interactive editors, and full-page text OCR are not included.
PDF layout analysis and GPU selection are automatic. Missing model assets are
downloaded once with a warning, then cached; document content stays on-device.
Use `--offline` to prohibit model downloads, or `--no-layout` for basic PDF
conversion without a model or native runtime.

## Run from source

Install Node 24+, the repository's pinned pnpm, and Bun 1.3.11:

```sh
pnpm install --frozen-lockfile
pnpm cli document.docx --format html
pnpm cli document.pdf --format epub --output book.epub
pnpm cli --help
```

Output format defaults to **EPUB**. If `--output` ends in `.epub`, `.html`,
`.htm`, `.md`, `.markdown`, `.html.zip`, `.md.zip`, or `.markdown.zip`, the format
is inferred from that extension (case-insensitively). Explicit `--format` takes
precedence. An unrecognized extension or stdout (`--output -`) defaults to EPUB;
bare `.zip` is ambiguous and requires `--format html-zip` or `markdown-zip`.

Output defaults to the input directory with the corresponding extension:
`.html`, `.html.zip`, `.md`, `.md.zip`, or `.epub`. Existing files are preserved
unless `--force` is supplied. Even with `--force`, input documents, presets,
model files, and their hard-link/symlink aliases cannot be replaced.

Use `--output -` to stream the result to stdout, including binary ZIP/EPUB.
Conversion warnings, runtime diagnostics, and file-write confirmations go to
stderr. Exit codes are `0` for success, `1` for conversion/I/O failure, and `2`
for invalid arguments. Formula recognition warnings can accompany a successful
conversion: uncertain or invalid recognition retains source content.

```sh
pnpm cli document.docx --format markdown --output notes.md
pnpm cli document.docx --style-preset headings.json --title "My book" \
  --author "First author" --author "Second author" --language nl-NL \
  --identifier urn:example:book --format epub --output book.epub
pnpm cli document.docx --conversion-date 2026-11-07 \
  --formula-mode mathml --format html-zip --output publication.zip
```

Style presets use the same validated `wordconvert.style-preset` version 1 schema
as SPA exports. They apply to DOCX only. Metadata overrides have typed user
provenance. Missing or invalid document language defaults to `en` with default
provenance and a warning; a valid document language is preserved. `--language`
overrides it explicitly. Supply `--conversion-date` as a date or UTC ISO timestamp to avoid
clock-dependent output; PDF page deadlines can still affect slow documents.

## Portable executable

```sh
pnpm cli:build
./apps/cli/dist/bun-darwin-arm64/wordconvert document.docx --format epub
```

The native target is selected automatically:

| Platform | Build directory |
| --- | --- |
| Apple Silicon macOS | `bun-darwin-arm64` |
| Intel macOS | `bun-darwin-x64` |
| Linux x64, glibc | `bun-linux-x64-baseline` |
| Linux arm64, glibc | `bun-linux-arm64` |
| Windows x64 | `bun-windows-x64-baseline` |

Copy the target directory to the destination machine; no Bun, Node, pnpm, or
Python installation is required there. The executable alone supports DOCX and
basic, geometry-based PDF conversion. Optional PDF rendering/ML loads native
libraries from the sibling `runtime/` folder, or from `--runtime-dir <path>`.
The CLI resolves the real executable path before finding `runtime/`, so a PATH
symlink and an unrelated working directory do not require this flag. No
temporary runtime extraction is needed. The default PDF mode requires the
complete bundle; executable-only PDF conversion requires `--no-layout`.
Keep the licence and notice files with redistributed executables and libraries.

### Put the CLI on PATH

The command is `wordconvert`, not `word-convert` or `wc` (the latter is the
standard word-count utility). On macOS/Linux, copy the complete bundle to a
stable directory and symlink its executable into a directory on your PATH:

```sh
# First-time installation on Apple Silicon macOS; adjust the target as needed.
mkdir -p ~/.local/share ~/.local/bin
cp -R apps/cli/dist/bun-darwin-arm64 ~/.local/share/wordconvert
ln -s ~/.local/share/wordconvert/wordconvert ~/.local/bin/wordconvert
wordconvert --help
```

If `~/.local/bin` is not already on PATH, add
`export PATH="$HOME/.local/bin:$PATH"` to your shell configuration and open a
new terminal. Keep `runtime/` beside the installed executable. Copying the
bundle instead of linking directly into a worktree keeps the command usable
after the worktree is removed. Rebuilding the repository does not update this
installed copy; replace the installed bundle deliberately when upgrading.

### Agent usage

A `SKILL.md` is not required: agents with shell access can discover the CLI
through `wordconvert --help`. Specify local input/output paths and the desired
format, check the exit status, and review warnings on stderr. Do not use
`--force` unless replacing the output is intended. PDF layout models are cached automatically, and GPU selection defaults to
`auto`; formula OCR requires `--formula-ocr`. First-use downloads emit a
warning rather than an interactive prompt, including when invoked by agents.
Use `--offline` to guarantee no network requests. Use `--no-layout` to avoid
default layout inference, or supply explicit model paths/provider choices.
For binary formats, use an output file rather than capturing stdout as text.
This guide contains the more detailed model setup and platform restrictions.

The **Build portable CLI** GitHub Actions workflow builds and smoke-checks
native bundles on each platform. Download its target-specific artifact. On
macOS/Linux, restore the executable bit with `chmod +x wordconvert` if the
artifact downloader did not preserve it. These are unsigned binaries and
normal OS download/security policies still apply.

Executable-only cross-compilation is also supported:

```sh
pnpm cli:build -- --target bun-windows-x64-baseline --no-runtime
pnpm cli:build -- --target bun-linux-arm64 --no-runtime
```

Native runtime bundles must be built on the destination OS/architecture, not
combined with another platform's native libraries. Linux bundles target glibc,
not Alpine/musl. Windows arm64 is not currently a bundle target.

## PDF defaults and optional formula OCR

PDF conversion defaults to native rendering and Heron layout analysis. The
basic `--no-layout` mode preserves text geometry and embedded raster images, and
reports its limitations. `--rasterize --no-layout` adds native canvas rendering for vectors,
equation crops, and page-image fallbacks without loading any ML models:

```sh
wordconvert document.pdf --rasterize --no-layout --format html
```

### First-use downloads and cache cleanup

Missing default models are downloaded from pinned HTTPS Hugging Face URLs
after a warning on stderr naming the file, size, destination, and cleanup
command. Exact byte counts and SHA-256 checksums are verified before atomic
publication; partial or failed downloads are cleaned up. Cached models are
rechecked before use. An invalid cache entry produces an error with cleanup
instructions rather than loading modified weights.

The cache contains only managed model files, never documents or output:

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Caches/wordconvert/models` |
| Linux | `$XDG_CACHE_HOME/wordconvert/models` or `~/.cache/wordconvert/models` |
| Windows | `%LOCALAPPDATA%/wordconvert/models` |

Override this with `--model-cache-dir <dir>`. Remove managed files with:

```sh
wordconvert --clear-model-cache
wordconvert --clear-model-cache --model-cache-dir /path/to/cache
```

Cleanup deletes only `heron.onnx`, `encoder.onnx`, `decoder.onnx`, and
`tokenizer.json` in that cache, not unrelated files, explicit model directories,
or the runtime bundle. Symlinked cache roots are rejected. The next default
conversion downloads missing models again. `--offline` permits verified cached
models or explicit local files, but fails if a required default model is
missing. Use `--no-layout --offline` for model-free PDF conversion.

Explicit paths bypass downloads. Use only trusted models: native model loading is
not a sandbox for arbitrary ONNX graphs. Missing or incompatible requested
models stop conversion rather than silently switching off the option.

### Heron layout analysis

The default is the official Docling Heron ONNX export at revision
`40bde044036bb181c130ddf6c51792187268748f`, approximately 164 MiB
(SHA-256 `59c81a3a2923042d85034ffc487f8f47e4854117e879aef89b2b9f728fb4922a`).
This export accepts uint8 page pixels plus original dimensions and returns
labels, scores, and pixel bounding boxes; the native adapter supports this
interface as well as the repository's FP32 raw-logit export. The shared label
mapping, detection threshold, and normalized geometry remain consistent.

You can still use a FP32 export of the same pinned Docling Heron model as the SPA.
Bun's native bindings do not support `Float16Array` inputs reliably; the SPA
retains its existing FP16 WebGPU/WASM model. Export FP32 once on a development
machine using the repository's pinned Python environment:

```sh
uv run --python 3.12 scripts/export-heron-onnx.py --fp32 \
  --output apps/cli/dist/models/heron_fp32.onnx
pnpm cli document.pdf \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

The FP32 model is approximately 164 MiB. The exporter validates its graph and
runs a real CPU inference pass. Copy this model wherever convenient on the
destination machine and pass its path with `--layout-model`. This avoids the
default download. `--no-layout` disables layout analysis entirely.

### TexTeller formula OCR

Enable OCR with `wordconvert document.pdf --formula-ocr`. It downloads and
caches the pinned TexTeller q4 encoder, decoder, and tokenizer on first use.
Formula OCR remains optional and is not full-page text OCR.

Alternatively, supply a directory containing `encoder.onnx`, `decoder.onnx`, and
`tokenizer.json` from the pinned TexTeller q4 export. Download manually:

```sh
mkdir -p apps/cli/dist/models/texteller
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/onnx/encoder_model_q4.onnx \
  --output apps/cli/dist/models/texteller/encoder.onnx
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/onnx/decoder_model_q4.onnx \
  --output apps/cli/dist/models/texteller/decoder.onnx
curl --fail --location \
  https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/9727784d91d7f8437dc7140941c4335284ce075e/tokenizer.json \
  --output apps/cli/dist/models/texteller/tokenizer.json
```

Verify SHA-256 before using or redistributing the files:

| File | SHA-256 |
| --- | --- |
| `encoder.onnx` | `de5fe45294a00f45af907b783f3f4764dbdc95386676f4e20175d912cfe8e59a` |
| `decoder.onnx` | `d937474a36f212cd704acc811b9eef32405f3aa20c5da812d7bf227abbc6004b` |
| `tokenizer.json` | `ec4ca954798a092faf6fefcfa47fb5f85d76cdf6ab170b624ae1a683d53dae14` |

```sh
pnpm cli document.pdf --formula-model-dir apps/cli/dist/models/texteller \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

Both model types enable native rasterization automatically. Layout is enabled
by default; use `--no-layout` with formula options to run OCR without Heron.
TexTeller adds approximately 245 MiB of assets and preserves the shared
candidate/crop/token limits and strict TeX validation.

### Automatic GPU selection

`--execution-provider auto` is the default: prefer bundled CoreML on macOS,
otherwise WebGPU, then CPU. If GPU model initialization fails, the CLI emits
the reason and retries on CPU. Provider selection is printed to stderr; a
bundled GPU backend alone does not prove compatible hardware exists.

Force a provider when automatic fallback is not desired:

```sh
pnpm cli document.pdf --execution-provider webgpu \
  --layout-model apps/cli/dist/models/heron_fp32.onnx \
  --formula-model-dir apps/cli/dist/models/texteller --format epub
pnpm cli document.pdf --execution-provider coreml \
  --layout-model apps/cli/dist/models/heron_fp32.onnx --format epub
```

No model path is needed with the default layout mode. Both models use the
selected provider. A provider missing from the supplied native runtime is an
error for an explicit choice, not a silent switch to CPU. `--execution-provider cpu`
forces portable CPU inference. Unsupported graph operators still execute on
the CPU, so choosing a GPU provider does not guarantee an entirely GPU workload.

CoreML is macOS-only and uses **MLProgram, static-shape graph partitions, and
CPU/GPU compute units**. Restricting partitions to static shapes avoids CoreML's
invalid shape predictions on Heron's dynamic graph and TexTeller's variable
decoder length. Some partitions remain on the CPU; this mode does not request
the Apple Neural Engine.

Native WebGPU uses Metal on macOS, Vulkan on Linux, and a supported native GPU
backend on Windows. It requires a compatible GPU/driver and a runtime built
with the provider. Full validation remains enabled to detect GPU validation errors.
Model sessions are awaited and released in reverse creation order before exit.
Repeated compiled runs with this lifecycle and validation configuration no
longer reproduced the previous shared-device shutdown failure.

Combined Heron/TexTeller conversion, repeated compiled-process exits, and
provider profiling were verified on Apple Silicon macOS with Bun 1.3.11 and
ONNX Runtime 1.29.0. Profiles contained CoreML/WebGPU execution nodes, not just
CPU fallback. Other platforms' hardware/driver combinations need their own
native smoke checks. GPU floating-point results and OCR can differ slightly
from CPU output; the SPA's independent browser GPU path is unchanged.

The pinned PDF.js dependency is patched to skip optional Node canvas discovery
when `DOMMatrix`, `Path2D`, and `ImageData` are already installed by the native
adapter. This avoids the misleading canvas-load warning inside compiled Bun
without filtering logs. Missing required native libraries still cause an
explicit CLI error naming the resolved runtime directory. Basic, model-free
conversion without native polyfills retains PDF.js's original diagnostics.

## Verification

```sh
pnpm exec vitest run apps/cli/src
pnpm cli:build
bun apps/cli/scripts/smoke.ts apps/cli/dist/bun-darwin-arm64/wordconvert
```

Set `WORDCONVERT_CLI_HERON_MODEL` to the local FP32 model and
`WORDCONVERT_TEXTELLER_MODEL_DIR` to the local TexTeller directory to enable
real-model tests. Set `WORDCONVERT_CLI_EXECUTION_PROVIDER` to `cpu`, `coreml`, or
`webgpu` for those tests and the compiled smoke script. With model paths set,
the smoke script performs three complete conversions in separate processes
and checks clean exit as well as actual Markdown output, catching shutdown
crashes that in-process tests would miss.

The CLI reuses preprocessing, decoding, tokenization, and
resource limits with the SPA; native rendering can differ in pixels and font
metrics between operating systems. See [hardening](hardening.md) for boundaries
and the existing [formula benchmarks](formula-benchmarks/README.md) for OCR
limitations.
