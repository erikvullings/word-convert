import type { CancellationSignal } from '@wordconvert/document-model';
import type {
  PdfFormulaImage,
  PdfFormulaRecognition,
  PdfFormulaRecognizer,
} from '@wordconvert/pdf-reader';
import { isValidTex } from '@wordconvert/math-converter';
import * as ort from 'onnxruntime-web/webgpu';

const BOS_TOKEN = 1;
const EOS_TOKEN = 2;
const DEFAULT_MAX_TOKENS = 512;
const MAX_WIDTH = 672;
const MAX_HEIGHT = 192;
const MIN_DIMENSION = 32;
const MODEL_MEAN = 0.7931 * 255;
const MODEL_DEVIATION = 0.1738 * 255;

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

export interface FormulaModelAssets {
  imageResizer: string | Uint8Array;
  encoder: string | Uint8Array;
  decoder: string | Uint8Array;
  tokenizer: string;
}

export interface RapidLatexFormulaRecognizer extends PdfFormulaRecognizer {
  prepare(): Promise<boolean>;
  dispose(): Promise<void>;
}

interface PreparedFormulaInput {
  width: number;
  height: number;
  data: Float32Array;
}

interface FormulaSessions {
  imageResizer: FormulaModelSession;
  encoder: FormulaModelSession;
  decoder: FormulaModelSession;
  backend: 'webgpu' | 'wasm';
}

export function createRapidLatexFormulaRecognizer(
  assets: FormulaModelAssets,
  options: {
    dependencies?: FormulaRecognizerDependencies;
    maxTokens?: number;
  } = {},
): RapidLatexFormulaRecognizer {
  const dependencies = options.dependencies ?? browserDependencies;
  const maxTokens = Math.min(
    DEFAULT_MAX_TOKENS,
    Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const tokenizer = parseTokenizer(assets.tokenizer);
  let sessions: Promise<FormulaSessions> | undefined;
  let disposed = false;

  const load = (): Promise<FormulaSessions> => {
    if (disposed)
      return Promise.reject(new Error('Formula recognizer is disposed.'));
    return (sessions ??= createSessions(assets, dependencies));
  };

  return {
    implementation: 'rapid-latex-ocr-onnx',
    async prepare() {
      try {
        await load();
        return true;
      } catch {
        sessions = undefined;
        return false;
      }
    },
    async recognize(image, recognitionOptions) {
      throwIfCancelled(recognitionOptions?.cancellation);
      const active = await load();
      throwIfCancelled(recognitionOptions?.cancellation);
      const input = await resizeForModel(
        prepareFormulaInput(image),
        active.imageResizer,
        dependencies,
        recognitionOptions?.cancellation,
      );
      const context = await runFirstOutput(active.encoder, {
        [requiredName(active.encoder.inputNames, 0, 'encoder input')]:
          dependencies.createTensor('float32', input.data, [
            1,
            1,
            input.height,
            input.width,
          ]),
      });
      const tokenIds = await decodeTokens(
        active.decoder,
        context,
        maxTokens,
        dependencies,
        recognitionOptions?.cancellation,
      );
      const tex = normalizeLatex(tokenizer.decode(tokenIds));
      if (!tex) throw new Error('Formula recognition returned empty TeX.');
      if (!dependencies.validateTex(tex))
        throw new Error('Formula recognition returned invalid TeX.');
      return {
        tex,
        diagnostics: { backend: active.backend, tokens: tokenIds.length },
      } satisfies PdfFormulaRecognition;
    },
    async dispose() {
      disposed = true;
      const active = sessions
        ? await sessions.catch(() => undefined)
        : undefined;
      sessions = undefined;
      active?.decoder.release();
      active?.encoder.release();
      active?.imageResizer.release();
    },
  };
}

export function prepareFormulaInput(
  image: PdfFormulaImage,
): PreparedFormulaInput {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.rgba.length !== image.width * image.height * 4
  )
    throw new Error('Formula recognizer received invalid RGBA pixels.');
  const gray = new Float32Array(image.width * image.height);
  for (let pixel = 0; pixel < gray.length; pixel++) {
    const offset = pixel * 4;
    const alpha = image.rgba[offset + 3]! / 255;
    const foreground =
      (image.rgba[offset]! +
        image.rgba[offset + 1]! +
        image.rgba[offset + 2]!) /
      3;
    gray[pixel] = foreground * alpha + 255 * (1 - alpha);
  }
  const constrained = constrainDimensions(image.width, image.height);
  const resized = resizeGray(
    gray,
    image.width,
    image.height,
    constrained.width,
    constrained.height,
  );
  return padAndNormalize(resized, constrained.width, constrained.height);
}

async function createSessions(
  assets: FormulaModelAssets,
  dependencies: FormulaRecognizerDependencies,
): Promise<FormulaSessions> {
  if (dependencies.webGpuAvailable()) {
    const created: FormulaModelSession[] = [];
    try {
      const imageResizer = await dependencies.createSession(
        assets.imageResizer,
        'webgpu',
      );
      created.push(imageResizer);
      const encoder = await dependencies.createSession(
        assets.encoder,
        'webgpu',
      );
      created.push(encoder);
      const decoder = await dependencies.createSession(
        assets.decoder,
        'webgpu',
      );
      return { imageResizer, encoder, decoder, backend: 'webgpu' };
    } catch {
      for (const session of created.reverse()) session.release();
    }
  }
  const imageResizer = await dependencies.createSession(
    assets.imageResizer,
    'wasm',
  );
  try {
    const encoder = await dependencies.createSession(assets.encoder, 'wasm');
    try {
      const decoder = await dependencies.createSession(assets.decoder, 'wasm');
      return { imageResizer, encoder, decoder, backend: 'wasm' };
    } catch (cause) {
      encoder.release();
      throw cause;
    }
  } catch (cause) {
    imageResizer.release();
    throw cause;
  }
}

async function resizeForModel(
  initial: PreparedFormulaInput,
  session: FormulaModelSession,
  dependencies: FormulaRecognizerDependencies,
  cancellation?: CancellationSignal,
): Promise<PreparedFormulaInput> {
  let input = initial;
  for (let iteration = 0; iteration < 10; iteration++) {
    throwIfCancelled(cancellation);
    const result = await runFirstOutput(session, {
      [requiredName(session.inputNames, 0, 'resizer input')]:
        dependencies.createTensor('float32', input.data, [
          1,
          1,
          input.height,
          input.width,
        ]),
    });
    const logits = floatData(result, 'resizer output');
    const width = Math.min(MAX_WIDTH, (argmax(logits) + 1) * 32);
    if (width === input.width) break;
    const height = Math.max(
      MIN_DIMENSION,
      Math.min(MAX_HEIGHT, Math.round((input.height * width) / input.width)),
    );
    const denormalized = new Float32Array(input.data.length);
    for (let index = 0; index < input.data.length; index++)
      denormalized[index] = input.data[index]! * MODEL_DEVIATION + MODEL_MEAN;
    input = padAndNormalize(
      resizeGray(denormalized, input.width, input.height, width, height),
      width,
      height,
    );
  }
  return input;
}

async function decodeTokens(
  session: FormulaModelSession,
  context: FormulaTensor,
  maxTokens: number,
  dependencies: FormulaRecognizerDependencies,
  cancellation?: CancellationSignal,
): Promise<number[]> {
  const output: number[] = [];
  const inputNames = [
    requiredName(session.inputNames, 0, 'decoder tokens'),
    requiredName(session.inputNames, 1, 'decoder mask'),
    requiredName(session.inputNames, 2, 'decoder context'),
  ] as const;
  for (let step = 0; step < maxTokens; step++) {
    throwIfCancelled(cancellation);
    const ids = [BOS_TOKEN, ...output];
    const result = await runFirstOutput(session, {
      [inputNames[0]]: dependencies.createTensor(
        'int64',
        BigInt64Array.from(ids, BigInt),
        [1, ids.length],
      ),
      [inputNames[1]]: dependencies.createTensor(
        'bool',
        new Uint8Array(ids.length).fill(1),
        [1, ids.length],
      ),
      [inputNames[2]]: context,
    });
    throwIfCancelled(cancellation);
    const logits = floatData(result, 'decoder output');
    const vocabulary = result.dims.at(-1);
    if (!vocabulary || logits.length < vocabulary)
      throw new Error('Formula decoder returned incompatible logits.');
    const next = argmax(logits.subarray(logits.length - vocabulary));
    output.push(next);
    if (next === EOS_TOKEN) return output;
  }
  throw new Error('Formula recognition exceeded its token limit.');
}

async function runFirstOutput(
  session: FormulaModelSession,
  feeds: Readonly<Record<string, FormulaTensor>>,
): Promise<FormulaTensor> {
  const outputs = await session.run(feeds);
  const name = requiredName(session.outputNames, 0, 'model output');
  const output = outputs[name];
  if (!output) throw new Error(`Formula model did not return ${name}.`);
  return output;
}

function requiredName(
  names: readonly string[],
  index: number,
  label: string,
): string {
  const name = names[index];
  if (!name) throw new Error(`Formula model is missing ${label}.`);
  return name;
}

function floatData(tensor: FormulaTensor, label: string): Float32Array {
  if (tensor.type !== 'float32' || !(tensor.data instanceof Float32Array))
    throw new Error(`Formula ${label} must be float32.`);
  return tensor.data;
}

function constrainDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function padAndNormalize(
  gray: Float32Array,
  width: number,
  height: number,
): PreparedFormulaInput {
  const paddedWidth = Math.max(MIN_DIMENSION, Math.ceil(width / 32) * 32);
  const paddedHeight = Math.max(MIN_DIMENSION, Math.ceil(height / 32) * 32);
  const data = new Float32Array(paddedWidth * paddedHeight);
  data.fill((255 - MODEL_MEAN) / MODEL_DEVIATION);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++)
      data[row * paddedWidth + column] =
        (gray[row * width + column]! - MODEL_MEAN) / MODEL_DEVIATION;
  return { width: paddedWidth, height: paddedHeight, data };
}

function resizeGray(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Float32Array {
  if (sourceWidth === width && sourceHeight === height) return source;
  const output = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const sourceRow = Math.max(
      0,
      Math.min(sourceHeight - 1, ((row + 0.5) * sourceHeight) / height - 0.5),
    );
    const rowStart = Math.floor(sourceRow);
    const rowEnd = Math.min(sourceHeight - 1, rowStart + 1);
    const rowWeight = sourceRow - rowStart;
    for (let column = 0; column < width; column++) {
      const sourceColumn = Math.max(
        0,
        Math.min(sourceWidth - 1, ((column + 0.5) * sourceWidth) / width - 0.5),
      );
      const columnStart = Math.floor(sourceColumn);
      const columnEnd = Math.min(sourceWidth - 1, columnStart + 1);
      const columnWeight = sourceColumn - columnStart;
      const top =
        source[rowStart * sourceWidth + columnStart]! * (1 - columnWeight) +
        source[rowStart * sourceWidth + columnEnd]! * columnWeight;
      const bottom =
        source[rowEnd * sourceWidth + columnStart]! * (1 - columnWeight) +
        source[rowEnd * sourceWidth + columnEnd]! * columnWeight;
      output[row * width + column] = top * (1 - rowWeight) + bottom * rowWeight;
    }
  }
  return output;
}

function argmax(values: Float32Array): number {
  if (values.length === 0) throw new Error('Formula model returned no values.');
  let selected = 0;
  for (let index = 1; index < values.length; index++)
    if (values[index]! > values[selected]!) selected = index;
  return selected;
}

function parseTokenizer(source: string): {
  decode(ids: readonly number[]): string;
} {
  const parsed = JSON.parse(source) as {
    model?: { vocab?: Record<string, number> };
  };
  if (!parsed.model?.vocab)
    throw new Error('Formula tokenizer has no vocabulary.');
  const tokens = new Map(
    Object.entries(parsed.model.vocab).map(([token, id]) => [id, token]),
  );
  const byteDecoder = createByteDecoder();
  return {
    decode(ids) {
      const encoded = ids
        .filter((id) => id !== 0 && id !== BOS_TOKEN && id !== EOS_TOKEN)
        .map((id) => {
          const token = tokens.get(id);
          if (token === undefined)
            throw new Error(`Formula tokenizer has no token ${id}.`);
          return token;
        })
        .join('');
      const bytes: number[] = [];
      for (const character of encoded) {
        const byte = byteDecoder.get(character);
        if (byte !== undefined) bytes.push(byte);
      }
      return new TextDecoder().decode(Uint8Array.from(bytes));
    },
  };
}

function createByteDecoder(): ReadonlyMap<string, number> {
  const bytes = [...range(33, 126), ...range(161, 172), ...range(174, 255)];
  const codePoints = [...bytes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (bytes.includes(byte)) continue;
    bytes.push(byte);
    codePoints.push(256 + extra++);
  }
  return new Map(
    bytes.map((byte, index) => [
      String.fromCodePoint(codePoints[index]!),
      byte,
    ]),
  );
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function normalizeLatex(source: string): string {
  return source
    .replaceAll('[PAD]', '')
    .replaceAll('[BOS]', '')
    .replaceAll('[EOS]', '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([{}_^=+\-*/])/g, '$1')
    .replace(/([{}_^=+\-*/])\s+/g, '$1')
    .trim();
}

function throwIfCancelled(cancellation?: CancellationSignal): void {
  if (cancellation?.cancelled)
    throw new Error('Formula recognition cancelled.');
}

const browserDependencies: FormulaRecognizerDependencies = {
  webGpuAvailable: () => typeof navigator !== 'undefined' && 'gpu' in navigator,
  async createSession(model, provider) {
    ort.env.wasm.numThreads = 1;
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
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
        const outputs = await session.run(ortFeeds);
        return Object.fromEntries(
          Object.entries(outputs).map(([name, tensor]) => [
            name,
            {
              type: tensor.type as FormulaTensorType,
              data: tensor.data as FormulaTensor['data'],
              dims: tensor.dims,
            },
          ]),
        );
      },
      release: () => session.release(),
    };
  },
  createTensor: (type, data, dims) => ({ type, data, dims }),
  validateTex: isValidTex,
};
