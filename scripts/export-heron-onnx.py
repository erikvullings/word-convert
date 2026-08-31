# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "numpy==1.26.4",
#   "onnx==1.17.0",
#   "onnxruntime==1.22.0",
#   "safetensors==0.5.3",
#   "torch==2.7.1",
#   "transformers==4.53.0",
# ]
# ///

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
import onnx
import onnxruntime
import torch
from onnxruntime.transformers.float16 import convert_float_to_float16
from transformers import RTDetrV2ForObjectDetection

MODEL_ID = "docling-project/docling-layout-heron"
MODEL_REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
MODEL_SHA256 = "02b3033fdd562d58cff9b8e1df88ffa7b77b760724e1bccfd180ee1d00bc7754"
INPUT_SIZE = 640


class HeronInferenceModel(torch.nn.Module):
    def __init__(self, model: RTDetrV2ForObjectDetection) -> None:
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        output = self.model(pixel_values=pixel_values)
        return output.logits, output.pred_boxes


def topologically_sort(model: onnx.ModelProto) -> None:
    available = {value.name for value in model.graph.input}
    available.update(value.name for value in model.graph.initializer)
    pending = list(model.graph.node)
    ordered: list[onnx.NodeProto] = []
    while pending:
        ready = [
            node
            for node in pending
            if all(not name or name in available for name in node.input)
        ]
        if not ready:
            names = ", ".join(node.name or node.op_type for node in pending[:5])
            raise RuntimeError(f"Could not topologically sort ONNX nodes: {names}")
        for node in ready:
            pending.remove(node)
            ordered.append(node)
            available.update(node.output)
    del model.graph.node[:]
    model.graph.node.extend(ordered)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Docling Heron to a browser-compatible ONNX model."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("apps/web/src/assets/heron/model_fp16.onnx"),
    )
    parser.add_argument(
        "--fp32",
        action="store_true",
        help="Keep FP32 weights instead of converting the exported model to FP16.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fp32_output = args.output if args.fp32 else args.output.with_suffix(".fp32.onnx")

    model = RTDetrV2ForObjectDetection.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION
    ).eval()
    inference_model = HeronInferenceModel(model).eval()
    sample = torch.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=torch.float32)

    with torch.inference_mode():
        torch.onnx.export(
            inference_model,
            (sample,),
            fp32_output,
            input_names=["pixel_values"],
            output_names=["logits", "pred_boxes"],
            dynamic_axes={"pixel_values": {0: "batch"}},
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )

    exported = onnx.load(fp32_output)
    onnx.checker.check_model(exported)
    if not args.fp32:
        converted = convert_float_to_float16(
            exported,
            keep_io_types=False,
        )
        topologically_sort(converted)
        onnx.checker.check_model(converted)
        onnx.save(converted, args.output)
        fp32_output.unlink()

    size_mib = args.output.stat().st_size / (1024 * 1024)
    session = onnxruntime.InferenceSession(
        str(args.output), providers=["CPUExecutionProvider"]
    )
    logits, pred_boxes = session.run(
        ["logits", "pred_boxes"],
        {"pixel_values": np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float16)},
    )
    if logits.shape != (1, 300, 17) or pred_boxes.shape != (1, 300, 4):
        raise RuntimeError(
            f"Unexpected Heron outputs: logits={logits.shape}, boxes={pred_boxes.shape}"
        )
    if not np.isfinite(logits).all() or not np.isfinite(pred_boxes).all():
        raise RuntimeError("Heron produced non-finite output values.")
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    if not args.fp32 and digest != MODEL_SHA256:
        raise RuntimeError(f"Heron model checksum changed: {digest}")
    print(f"Exported {args.output} ({size_mib:.1f} MiB)")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()
