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
  release(): void | Promise<void>;
}

export interface FormulaRecognizerDependencies {
  fallbackBackend?: 'wasm' | 'cpu' | 'coreml' | 'webgpu';
  webGpuAvailable(): boolean;
  createSession(
    model: string | Uint8Array,
    provider: 'webgpu' | 'wasm' | 'cpu' | 'coreml',
  ): Promise<FormulaModelSession>;
  createTensor(
    type: FormulaTensorType,
    data: FormulaTensor['data'],
    dims: readonly number[],
  ): FormulaTensor;
  validateTex(tex: string): boolean;
}
