import type {
  PdfLayoutDetector,
  PdfLayoutLabel,
  PdfLayoutRegion,
} from './pdfjs.ts';

export interface HeronSession {
  run(
    input: Float32Array,
  ): Promise<
    | { logits: Float32Array; boxes: Float32Array }
    | { labels: BigInt64Array; scores: Float32Array; boxes: Float32Array }
  >;
  release(): void | Promise<void>;
}

export interface HeronDependencies {
  createSession(model: string | Uint8Array): Promise<HeronSession>;
  strict?: boolean;
}

const HERON_INPUT_SIZE = 640;
const HERON_THRESHOLD = 0.6;
const HERON_LABELS = [
  'caption',
  'footnote',
  'formula',
  'list_item',
  'page_footer',
  'page_header',
  'picture',
  'section_header',
  'table',
  'text',
  'title',
  'document_index',
  'code',
  'checkbox_selected',
  'checkbox_unselected',
  'form',
  'key_value_region',
] as const satisfies readonly PdfLayoutLabel[];

export interface HeronLayoutDetector extends PdfLayoutDetector {
  prepare(): Promise<boolean>;
  dispose(): Promise<void>;
}

export function createHeronLayoutDetector(
  model: string | Uint8Array,
  dependencies: HeronDependencies,
): HeronLayoutDetector {
  let session: Promise<HeronSession> | undefined;
  let disabled = false;
  return {
    inputSize: HERON_INPUT_SIZE,
    async prepare() {
      if (disabled) return false;
      try {
        session ??= dependencies.createSession(model);
        await session;
        return true;
      } catch (error) {
        disabled = true;
        if (dependencies.strict) throw error;
        return false;
      }
    },
    async detect(image, cancellation) {
      if (image.width !== HERON_INPUT_SIZE || image.height !== HERON_INPUT_SIZE)
        throw new Error('Heron requires a 640 by 640 page image.');
      if (disabled || cancellation?.cancelled) return [];
      try {
        if (!(await this.prepare())) return [];
        const inferenceSession = session ? await session : undefined;
        if (!inferenceSession) return [];
        if (cancellation?.cancelled) return [];
        const inputData = rgbaToHeronInput(
          image.rgba,
          image.width,
          image.height,
        );
        const result = await inferenceSession.run(inputData);
        if (cancellation?.cancelled) return [];
        if ('scores' in result)
          return decodeHeronPostprocessedDetections(
            result.labels,
            result.scores,
            result.boxes,
            HERON_THRESHOLD,
          );
        return decodeHeronDetections(
          result.logits,
          result.boxes,
          HERON_THRESHOLD,
        );
      } catch (error) {
        disabled = true;
        if (dependencies.strict) throw error;
        return [];
      }
    },
    async dispose() {
      const active = session;
      session = undefined;
      disabled = false;
      const inferenceSession = active
        ? await active.catch(() => undefined)
        : undefined;
      await inferenceSession?.release();
    },
  };
}

export function decodeHeronPostprocessedDetections(
  labels: BigInt64Array,
  scores: Float32Array,
  boxes: Float32Array,
  threshold: number,
): PdfLayoutRegion[] {
  if (labels.length !== scores.length || boxes.length !== scores.length * 4)
    throw new Error('Heron returned incompatible detection tensors.');
  const detections: PdfLayoutRegion[] = [];
  for (let index = 0; index < scores.length; index++) {
    const confidence = scores[index]!;
    const label = HERON_LABELS[Number(labels[index])];
    const coordinates = boxes.subarray(index * 4, index * 4 + 4);
    if (
      !label ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !coordinates.every(Number.isFinite)
    )
      throw new Error('Heron returned invalid postprocessed detections.');
    if (confidence < threshold) continue;
    const left = clamp(coordinates[0]! / HERON_INPUT_SIZE);
    const top = clamp(coordinates[1]! / HERON_INPUT_SIZE);
    const right = clamp(coordinates[2]! / HERON_INPUT_SIZE);
    const bottom = clamp(coordinates[3]! / HERON_INPUT_SIZE);
    detections.push({
      label,
      confidence,
      x: left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    });
  }
  return detections.sort((left, right) => right.confidence - left.confidence);
}

export function rgbaToHeronInput(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const pixels = width * height;
  if (rgba.length !== pixels * 4)
    throw new Error('Heron received an invalid RGBA page image.');
  const input = new Float32Array(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const source = pixel * 4;
    input[pixel] = rgba[source]! / 255;
    input[pixels + pixel] = rgba[source + 1]! / 255;
    input[pixels * 2 + pixel] = rgba[source + 2]! / 255;
  }
  return input;
}

export function decodeHeronDetections(
  logits: Float32Array,
  boxes: Float32Array,
  threshold: number,
): PdfLayoutRegion[] {
  const labels = HERON_LABELS.length;
  if (
    logits.length % labels !== 0 ||
    boxes.length !== (logits.length / labels) * 4
  )
    throw new Error('Heron returned incompatible detection tensors.');
  const detections: PdfLayoutRegion[] = [];
  const queries = logits.length / labels;
  for (let query = 0; query < queries; query++) {
    const boxOffset = query * 4;
    const centerX = boxes[boxOffset]!;
    const centerY = boxes[boxOffset + 1]!;
    const boxWidth = boxes[boxOffset + 2]!;
    const boxHeight = boxes[boxOffset + 3]!;
    const left = clamp(centerX - boxWidth / 2);
    const top = clamp(centerY - boxHeight / 2);
    const right = clamp(centerX + boxWidth / 2);
    const bottom = clamp(centerY + boxHeight / 2);
    for (let label = 0; label < labels; label++) {
      const confidence = sigmoid(logits[query * labels + label]!);
      if (confidence < threshold) continue;
      detections.push({
        label: HERON_LABELS[label]!,
        confidence,
        x: left,
        top,
        width: right - left,
        height: bottom - top,
      });
    }
  }
  return detections.sort((left, right) => right.confidence - left.confidence);
}

export function float32ToFloat16(values: Float32Array): Uint16Array {
  const output = new Uint16Array(values.length);
  const float = new Float32Array(1);
  const bits = new Uint32Array(float.buffer);
  for (let index = 0; index < values.length; index++) {
    float[0] = values[index]!;
    const value = bits[0]!;
    const sign = (value >>> 16) & 0x8000;
    const sourceExponent = (value >>> 23) & 0xff;
    const mantissa = value & 0x7fffff;
    if (sourceExponent === 0xff) {
      output[index] = sign | 0x7c00 | (mantissa === 0 ? 0 : 0x0200);
      continue;
    }
    const exponent = sourceExponent - 127 + 15;
    if (exponent >= 31) {
      output[index] = sign | 0x7c00;
      continue;
    }
    if (exponent <= 0) {
      if (exponent < -10) {
        output[index] = sign;
        continue;
      }
      const rounded = ((mantissa | 0x800000) >> (1 - exponent)) + 0x1000;
      output[index] = sign | (rounded >> 13);
      continue;
    }
    const rounded = mantissa + 0x1000;
    output[index] = sign | (exponent << 10) | (rounded >> 13);
  }
  return output;
}

export function float16ToFloat32(values: Uint16Array): Float32Array {
  const output = new Float32Array(values.length);
  const float = new Float32Array(1);
  const bits = new Uint32Array(float.buffer);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    const sign = (value & 0x8000) << 16;
    let exponent = (value >>> 10) & 0x1f;
    let mantissa = value & 0x03ff;
    if (exponent === 0) {
      if (mantissa === 0) {
        bits[0] = sign;
      } else {
        exponent = 1;
        while ((mantissa & 0x0400) === 0) {
          mantissa <<= 1;
          exponent--;
        }
        bits[0] = sign | ((exponent + 112) << 23) | ((mantissa & 0x03ff) << 13);
      }
    } else if (exponent === 0x1f) {
      bits[0] = sign | 0x7f800000 | (mantissa << 13);
    } else {
      bits[0] = sign | ((exponent + 112) << 23) | (mantissa << 13);
    }
    output[index] = float[0]!;
  }
  return output;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
