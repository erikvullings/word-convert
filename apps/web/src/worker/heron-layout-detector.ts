import * as ort from 'onnxruntime-web/webgpu';
import {
  createHeronLayoutDetector as createDetector,
  float16ToFloat32,
  float32ToFloat16,
} from '@wordconvert/pdf-reader';

export {
  decodeHeronDetections,
  float16ToFloat32,
  float32ToFloat16,
  rgbaToHeronInput,
  type HeronLayoutDetector,
} from '@wordconvert/pdf-reader';

export function createHeronLayoutDetector(model: string | Uint8Array) {
  return createDetector(model, {
    async createSession(source) {
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const webGpuAvailable =
        typeof navigator !== 'undefined' && 'gpu' in navigator;
      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: webGpuAvailable ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      };
      const session =
        typeof source === 'string'
          ? await ort.InferenceSession.create(source, options)
          : await ort.InferenceSession.create(source, options);
      return {
        async run(data) {
          const input = new ort.Tensor(
            'float16',
            float32ToFloat16(data),
            [1, 3, 640, 640],
          );
          let result: ort.InferenceSession.OnnxValueMapType | undefined;
          try {
            result = await session.run({ pixel_values: input });
            return {
              logits: Float32Array.from(tensorToFloat32(result.logits)),
              boxes: Float32Array.from(tensorToFloat32(result.pred_boxes)),
            };
          } finally {
            input.dispose();
            for (const tensor of Object.values(result ?? {})) tensor.dispose();
          }
        },
        release: () => session.release(),
      };
    },
  });
}

function tensorToFloat32(tensor: ort.Tensor | undefined): Float32Array {
  if (!tensor)
    throw new Error('Heron did not return a required output tensor.');
  if (tensor.type === 'float32' && tensor.data instanceof Float32Array)
    return tensor.data;
  if (tensor.type === 'float16' && ArrayBuffer.isView(tensor.data))
    return float16ToFloat32(
      new Uint16Array(
        tensor.data.buffer,
        tensor.data.byteOffset,
        tensor.data.byteLength / 2,
      ),
    );
  throw new Error('Heron returned an unsupported output tensor.');
}
