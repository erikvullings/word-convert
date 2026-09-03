import { isValidTex } from '@wordconvert/math-converter';
import * as ort from 'onnxruntime-web/webgpu';

export type FormulaTensorType = 'float32' | 'int64' | 'bool';
export interface FormulaTensor {
  type: FormulaTensorType;
  data: Float32Array | BigInt64Array | Uint8Array;
  dims: readonly number[];
}

export interface FormulaModelSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(
    feeds: Readonly<Record<string, FormulaTensor>>,
  ): Promise<Record<string, FormulaTensor>>;
  release(): void;
}

export interface FormulaRecognizerDependencies {
  webGpuAvailable(): boolean;
  createSession(
    model: string | Uint8Array,
    provider: 'webgpu' | 'wasm',
  ): Promise<FormulaModelSession>;
  createTensor(
    type: FormulaTensorType,
    data: FormulaTensor['data'],
    dims: readonly number[],
  ): FormulaTensor;
  validateTex(tex: string): boolean;
}

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
