# Docling Heron ONNX asset

`model_fp16.onnx` is an FP16 ONNX export of
[`docling-project/docling-layout-heron`](https://huggingface.co/docling-project/docling-layout-heron),
revision `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`.

- Upstream licence: Apache-2.0
- Upstream architecture: RT-DETR-v2
- Input: FP16 `[1, 3, 640, 640]`, RGB values rescaled to `0..1`
- Outputs: FP16 `logits [1, 300, 17]` and `pred_boxes [1, 300, 4]`
- SHA-256: `02b3033fdd562d58cff9b8e1df88ffa7b77b760724e1bccfd180ee1d00bc7754`

Regenerate and validate the model from the repository root:

```sh
uv run --python 3.12 scripts/export-heron-onnx.py
```

The exporter pins its Python dependencies and upstream revision, validates the
ONNX graph, and executes one inference pass before reporting success. The model
is bundled as a hashed Vite asset and cached by the service worker after its
first use rather than during installation.
The Apache-2.0 terms are included in `LICENSES/Apache-2.0.txt`.
