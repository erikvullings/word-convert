import { isValidTex } from '@wordconvert/math-converter';
import * as ort from 'onnxruntime-web/webgpu';

import type {
  FormulaTensor,
  FormulaTensorType,
  FormulaRecognizerDependencies,
} from '@wordconvert/pdf-reader';
export type {
  FormulaTensor,
  FormulaTensorType,
  FormulaModelSession,
  FormulaRecognizerDependencies,
} from '@wordconvert/pdf-reader';

export const browserFormulaRecognizerDependencies: FormulaRecognizerDependencies =
  {
    webGpuAvailable: () =>
      typeof navigator !== 'undefined' && 'gpu' in navigator,
    async createSession(model, provider) {
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      };
      const session =
        typeof model === 'string'
          ? await ort.InferenceSession.create(model, sessionOptions)
          : await ort.InferenceSession.create(model, sessionOptions);
      return {
        inputNames: session.inputNames,
        outputNames: session.outputNames,
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds))
            ortFeeds[name] = new ort.Tensor(tensor.type, tensor.data, [
              ...tensor.dims,
            ]);
          let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
          try {
            outputs = await session.run(ortFeeds);
            return Object.fromEntries(
              Object.entries(outputs).map(([name, tensor]) => [
                name,
                {
                  type: tensor.type as FormulaTensorType,
                  data: cloneTensorData(tensor.data),
                  dims: [...tensor.dims],
                },
              ]),
            );
          } finally {
            for (const tensor of Object.values(ortFeeds)) tensor.dispose();
            for (const tensor of Object.values(outputs ?? {})) tensor.dispose();
          }
        },
        release: () => session.release(),
      };
    },
    createTensor: (type, data, dims) => ({ type, data, dims }),
    validateTex: isValidTex,
  };

function cloneTensorData(data: ort.Tensor['data']): FormulaTensor['data'] {
  if (data instanceof Float32Array) return data.slice();
  if (data instanceof BigInt64Array) return data.slice();
  if (data instanceof Uint8Array) return data.slice();
  throw new Error('Formula model returned an unsupported tensor type.');
}
