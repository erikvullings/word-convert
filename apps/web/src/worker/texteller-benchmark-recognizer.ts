import type { CancellationSignal } from '@wordconvert/document-model';
import type {
  PdfFormulaImage,
  PdfFormulaRecognizer,
} from '@wordconvert/pdf-reader';

import {
  browserFormulaRecognizerDependencies,
  type FormulaModelSession,
  type FormulaRecognizerDependencies,
  type FormulaTensor,
} from './formula-model-runtime.ts';

const BOS_TOKEN = 0;
const PAD_TOKEN = 1;
const EOS_TOKEN = 2;
const DECODER_START_TOKEN = BOS_TOKEN;
const IMAGE_SIZE = 448;
const RESIZE_SIZE = IMAGE_SIZE - 1;
const IMAGE_MEAN = 0.9545467;
const IMAGE_STD = 0.15394445;
const DEFAULT_MAX_TOKENS = 512;
const MAX_TOKENS = 1024;

export interface TexTellerModelAssets {
  encoder: string | Uint8Array;
  decoder: string | Uint8Array;
  tokenizer: string;
}

export interface TexTellerBenchmarkRecognizer extends PdfFormulaRecognizer {
  prepare(): Promise<boolean>;
  dispose(): Promise<void>;
}

export function createTexTellerBenchmarkRecognizer(
  assets: TexTellerModelAssets,
  options: {
    dependencies?: FormulaRecognizerDependencies;
    maxTokens?: number;
  } = {},
): TexTellerBenchmarkRecognizer {
  const dependencies =
    options.dependencies ?? browserFormulaRecognizerDependencies;
  const maxTokens = Math.min(
    MAX_TOKENS,
    Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const tokenizer = parseTokenizer(assets.tokenizer);
  let sessions: Promise<TexTellerSessions> | undefined;
  let disposed = false;
  const load = (): Promise<TexTellerSessions> => {
    if (disposed)
      return Promise.reject(
        new Error('TexTeller benchmark recognizer is disposed.'),
      );
    return (sessions ??= createSessions(assets, dependencies));
  };
  return {
    implementation: 'texteller-onnx-q4',
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
      const lines: string[] = [];
      let tokens = 0;
      for (const row of splitTexTellerRows(image)) {
        const input = prepareTexTellerInput(row);
        const context = await runFirstOutput(active.encoder, {
          [requiredName(active.encoder.inputNames, 0, 'encoder input')]:
            dependencies.createTensor('float32', input.data, [
              1,
              1,
              IMAGE_SIZE,
              IMAGE_SIZE,
            ]),
        });
        const tokenIds = await decodeTokens(
          active.decoder,
          context,
          maxTokens,
          dependencies,
          recognitionOptions?.cancellation,
        );
        tokens += tokenIds.length;
        lines.push(normalizeTexTellerLatex(tokenizer.decode(tokenIds)));
      }
      const tex =
        lines.length === 1
          ? lines[0]!
          : `\\begin{aligned}${lines.join(' \\\\ ')}\\end{aligned}`;
      if (!tex || tokens > maxTokens || !dependencies.validateTex(tex))
        throw new Error('TexTeller returned invalid TeX.');
      return {
        tex,
        diagnostics: { backend: active.backend, tokens },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const active = sessions
        ? await sessions.catch(() => undefined)
        : undefined;
      sessions = undefined;
      active?.decoder.release();
      active?.encoder.release();
    },
  };
}

interface TexTellerSessions {
  encoder: FormulaModelSession;
  decoder: FormulaModelSession;
  backend: 'webgpu' | 'wasm';
}

interface PreparedTexTellerInput {
  width: number;
  height: number;
  data: Float32Array;
}

export function prepareTexTellerInput(
  image: PdfFormulaImage,
): PreparedTexTellerInput {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.rgba.length !== image.width * image.height * 4
  )
    throw new Error('TexTeller received invalid RGBA pixels.');

  const rgb = compositeRgb(image);
  const bounds = contentBounds(rgb, image.width, image.height);
  const cropped = cropGrayscale(rgb, image.width, bounds);
  const scale = Math.min(
    RESIZE_SIZE / Math.min(bounds.width, bounds.height),
    IMAGE_SIZE / Math.max(bounds.width, bounds.height),
  );
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const resized = resizeBicubic(
    cropped,
    bounds.width,
    bounds.height,
    width,
    height,
  );
  const data = new Float32Array(IMAGE_SIZE * IMAGE_SIZE);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++)
      data[row * IMAGE_SIZE + column] =
        (resized[row * width + column]! / 255 - IMAGE_MEAN) / IMAGE_STD;
  return { width: IMAGE_SIZE, height: IMAGE_SIZE, data };
}

export function splitTexTellerRows(
  image: PdfFormulaImage,
): readonly PdfFormulaImage[] {
  if (image.width < 20 || image.height < 20) return [image];
  const activeRows: number[] = [];
  const minimumInk = Math.max(2, Math.ceil(image.width * 0.01));
  for (let row = 0; row < image.height; row++) {
    let ink = 0;
    for (let column = 0; column < image.width; column++) {
      const offset = (row * image.width + column) * 4;
      const alpha = image.rgba[offset + 3]! / 255;
      const darkness =
        255 -
        ((image.rgba[offset]! +
          image.rgba[offset + 1]! +
          image.rgba[offset + 2]!) /
          3) *
          alpha;
      if (darkness > 30) ink++;
    }
    if (ink >= minimumInk) activeRows.push(row);
  }
  const bands: Array<{ top: number; bottom: number }> = [];
  const mergeGap = Math.max(2, Math.floor(image.height * 0.04));
  for (const row of activeRows) {
    const previous = bands.at(-1);
    if (previous && row - previous.bottom <= mergeGap) previous.bottom = row;
    else bands.push({ top: row, bottom: row });
  }
  if (bands.length < 2 || bands.length > 4) return [image];
  const extents = bands.map((band) => inkExtent(image, band));
  const overallWidth = Math.max(...extents.map(({ width }) => width));
  if (
    overallWidth < image.width * 0.25 ||
    extents.some(({ width }) => width < overallWidth * 0.35)
  )
    return [image];
  return bands.map((band) => cropFormulaRow(image, band));
}

function inkExtent(
  image: PdfFormulaImage,
  band: { top: number; bottom: number },
): { width: number } {
  let left = image.width;
  let right = -1;
  for (let row = band.top; row <= band.bottom; row++)
    for (let column = 0; column < image.width; column++) {
      const offset = (row * image.width + column) * 4;
      if (
        image.rgba[offset]! < 225 ||
        image.rgba[offset + 1]! < 225 ||
        image.rgba[offset + 2]! < 225
      ) {
        left = Math.min(left, column);
        right = Math.max(right, column);
      }
    }
  return { width: Math.max(0, right - left + 1) };
}

function cropFormulaRow(
  image: PdfFormulaImage,
  band: { top: number; bottom: number },
): PdfFormulaImage {
  const padding = Math.max(2, Math.floor(image.height * 0.03));
  const top = Math.max(0, band.top - padding);
  const bottom = Math.min(image.height - 1, band.bottom + padding);
  const height = bottom - top + 1;
  const rgba = new Uint8ClampedArray(image.width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = (top + row) * image.width * 4;
    rgba.set(
      image.rgba.subarray(start, start + image.width * 4),
      row * image.width * 4,
    );
  }
  return { width: image.width, height, rgba };
}

async function createSessions(
  assets: TexTellerModelAssets,
  dependencies: FormulaRecognizerDependencies,
): Promise<TexTellerSessions> {
  if (dependencies.webGpuAvailable()) {
    const created: FormulaModelSession[] = [];
    try {
      const encoder = await dependencies.createSession(
        assets.encoder,
        'webgpu',
      );
      created.push(encoder);
      const decoder = await dependencies.createSession(
        assets.decoder,
        'webgpu',
      );
      return { encoder, decoder, backend: 'webgpu' };
    } catch {
      for (const session of created.reverse()) session.release();
    }
  }
  const encoder = await dependencies.createSession(assets.encoder, 'wasm');
  try {
    const decoder = await dependencies.createSession(assets.decoder, 'wasm');
    return { encoder, decoder, backend: 'wasm' };
  } catch (cause) {
    encoder.release();
    throw cause;
  }
}

async function decodeTokens(
  session: FormulaModelSession,
  context: FormulaTensor,
  maxTokens: number,
  dependencies: FormulaRecognizerDependencies,
  cancellation?: CancellationSignal,
): Promise<number[]> {
  const output: number[] = [];
  const tokenInput = requiredName(session.inputNames, 0, 'decoder tokens');
  const contextInput = requiredName(session.inputNames, 1, 'decoder context');
  for (let step = 0; step < maxTokens; step++) {
    throwIfCancelled(cancellation);
    const ids = [DECODER_START_TOKEN, ...output];
    const result = await runFirstOutput(session, {
      [tokenInput]: dependencies.createTensor(
        'int64',
        BigInt64Array.from(ids, BigInt),
        [1, ids.length],
      ),
      [contextInput]: context,
    });
    throwIfCancelled(cancellation);
    const logits = floatData(result, 'decoder output');
    const vocabulary = result.dims.at(-1);
    if (!vocabulary || logits.length < vocabulary)
      throw new Error('TexTeller decoder returned incompatible logits.');
    const next = argmax(logits.subarray(logits.length - vocabulary));
    output.push(next);
    if (next === EOS_TOKEN) return output;
  }
  throw new Error(
    `TexTeller recognition exceeded its token limit (tokens: ${output.slice(0, 16).join(',')}).`,
  );
}

async function runFirstOutput(
  session: FormulaModelSession,
  feeds: Readonly<Record<string, FormulaTensor>>,
): Promise<FormulaTensor> {
  const outputs = await session.run(feeds);
  const name = requiredName(session.outputNames, 0, 'model output');
  const output = outputs[name];
  if (!output) throw new Error(`TexTeller model did not return ${name}.`);
  return output;
}

function requiredName(
  names: readonly string[],
  index: number,
  label: string,
): string {
  const name = names[index];
  if (!name) throw new Error(`TexTeller model is missing ${label}.`);
  return name;
}

function floatData(tensor: FormulaTensor, label: string): Float32Array {
  if (tensor.type !== 'float32' || !(tensor.data instanceof Float32Array))
    throw new Error(`TexTeller ${label} must be float32.`);
  return tensor.data;
}

function compositeRgb(image: PdfFormulaImage): Uint8Array {
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const source = pixel * 4;
    const target = pixel * 3;
    const alpha = image.rgba[source + 3]! / 255;
    for (let channel = 0; channel < 3; channel++)
      rgb[target + channel] = Math.round(
        image.rgba[source + channel]! * alpha + 255 * (1 - alpha),
      );
  }
  return rgb;
}

function contentBounds(
  rgb: Uint8Array,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const colors = new Map<string, { count: number; rgb: readonly number[] }>();
  for (const pixel of corners) {
    const offset = pixel * 3;
    const color = [rgb[offset]!, rgb[offset + 1]!, rgb[offset + 2]!] as const;
    const key = color.join(',');
    const existing = colors.get(key);
    colors.set(key, { count: (existing?.count ?? 0) + 1, rgb: color });
  }
  const background = [...colors.values()].sort((a, b) => b.count - a.count)[0]!
    .rgb;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 3;
      const difference =
        0.299 * Math.abs(rgb[offset]! - background[0]!) +
        0.587 * Math.abs(rgb[offset + 1]! - background[1]!) +
        0.114 * Math.abs(rgb[offset + 2]! - background[2]!);
      if (difference <= 15) continue;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
  return right < left
    ? { left: 0, top: 0, width, height }
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function cropGrayscale(
  rgb: Uint8Array,
  sourceWidth: number,
  bounds: { left: number; top: number; width: number; height: number },
): Float32Array {
  const gray = new Float32Array(bounds.width * bounds.height);
  for (let row = 0; row < bounds.height; row++)
    for (let column = 0; column < bounds.width; column++) {
      const source =
        ((bounds.top + row) * sourceWidth + bounds.left + column) * 3;
      gray[row * bounds.width + column] =
        0.2989 * rgb[source]! +
        0.587 * rgb[source + 1]! +
        0.114 * rgb[source + 2]!;
    }
  return gray;
}

function resizeBicubic(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Float32Array {
  const output = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const sourceRow = ((row + 0.5) * sourceHeight) / height - 0.5;
    const rowBase = Math.floor(sourceRow);
    for (let column = 0; column < width; column++) {
      const sourceColumn = ((column + 0.5) * sourceWidth) / width - 0.5;
      const columnBase = Math.floor(sourceColumn);
      let value = 0;
      let weight = 0;
      for (let rowOffset = -1; rowOffset <= 2; rowOffset++)
        for (let columnOffset = -1; columnOffset <= 2; columnOffset++) {
          const sampleRow = Math.max(
            0,
            Math.min(sourceHeight - 1, rowBase + rowOffset),
          );
          const sampleColumn = Math.max(
            0,
            Math.min(sourceWidth - 1, columnBase + columnOffset),
          );
          const sampleWeight =
            cubicWeight(sourceRow - (rowBase + rowOffset)) *
            cubicWeight(sourceColumn - (columnBase + columnOffset));
          value +=
            source[sampleRow * sourceWidth + sampleColumn]! * sampleWeight;
          weight += sampleWeight;
        }
      output[row * width + column] = Math.max(0, Math.min(255, value / weight));
    }
  }
  return output;
}

function cubicWeight(distance: number): number {
  const absolute = Math.abs(distance);
  if (absolute <= 1) return (1.5 * absolute - 2.5) * absolute * absolute + 1;
  if (absolute < 2)
    return ((-0.5 * absolute + 2.5) * absolute - 4) * absolute + 2;
  return 0;
}

function argmax(values: Float32Array): number {
  if (values.length === 0) throw new Error('TexTeller returned no values.');
  let selected = 0;
  for (let index = 1; index < values.length; index++)
    if (values[index]! > values[selected]!) selected = index;
  return selected;
}

function parseTokenizer(source: string): {
  decode(ids: readonly number[]): string;
} {
  const parsed = JSON.parse(source) as {
    added_tokens?: { id: number; content: string; special?: boolean }[];
    model?: { vocab?: Record<string, number> };
  };
  if (!parsed.model?.vocab)
    throw new Error('TexTeller tokenizer has no vocabulary.');
  const tokens = new Map<number, { content: string; raw: boolean }>();
  for (const [content, id] of Object.entries(parsed.model.vocab))
    tokens.set(id, { content, raw: false });
  const special = new Set([BOS_TOKEN, PAD_TOKEN, EOS_TOKEN]);
  for (const token of parsed.added_tokens ?? []) {
    tokens.set(token.id, { content: token.content, raw: true });
    if (token.special) special.add(token.id);
  }
  const byteDecoder = createByteDecoder();
  return {
    decode(ids) {
      const chunks: string[] = [];
      let bytes: number[] = [];
      const flush = () => {
        if (bytes.length > 0)
          chunks.push(new TextDecoder().decode(Uint8Array.from(bytes)));
        bytes = [];
      };
      for (const id of ids) {
        if (special.has(id)) continue;
        const token = tokens.get(id);
        if (!token) throw new Error(`TexTeller tokenizer has no token ${id}.`);
        if (token.raw) {
          flush();
          chunks.push(token.content);
          continue;
        }
        for (const character of token.content) {
          const byte = byteDecoder.get(character);
          if (byte === undefined)
            throw new Error(`TexTeller tokenizer cannot decode token ${id}.`);
          bytes.push(byte);
        }
      }
      flush();
      return chunks.join('');
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

export function normalizeTexTellerLatex(source: string): string {
  const trimmed = source.trim();
  const unwrapped =
    (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) ||
    (trimmed.startsWith('\\(') && trimmed.endsWith('\\)'))
      ? trimmed.slice(2, -2)
      : trimmed.replace(/^\$\$?|\$\$?$/g, '');
  return unwrapped
    .replace(/\s+/g, ' ')
    .replace(/\s+([{}_^=+\-*/])/g, '$1')
    .replace(/([{}_^=+\-*/])\s+/g, '$1')
    .trim();
}

function throwIfCancelled(cancellation?: CancellationSignal): void {
  if (cancellation?.cancelled)
    throw new Error('TexTeller recognition cancelled.');
}
