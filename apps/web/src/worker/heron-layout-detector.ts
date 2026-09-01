import type {
  PdfLayoutDetector,
  PdfLayoutLabel,
  PdfLayoutRegion,
} from '@wordconvert/pdf-reader';
import * as ort from 'onnxruntime-web/webgpu';

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
}

export function createHeronLayoutDetector(
  model: string | Uint8Array,
): HeronLayoutDetector {
  let session: Promise<ort.InferenceSession> | undefined;
  let disabled = false;
  return {
    inputSize: HERON_INPUT_SIZE,
    async prepare() {
      if (disabled) return false;
      try {
        session ??= createSession(model);
        await session;
        return true;
      } catch {
        disabled = true;
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
        const input = rgbaToHeronInput(image.rgba, image.width, image.height);
        const result = await inferenceSession.run({
          pixel_values: new ort.Tensor('float16', float32ToFloat16(input), [
            1,
            3,
            image.height,
            image.width,
          ]),
        });
        if (cancellation?.cancelled) return [];
        const logits = tensorToFloat32(result.logits);
        const boxes = tensorToFloat32(result.pred_boxes);
        return decodeHeronDetections(logits, boxes, HERON_THRESHOLD);
      } catch {
        disabled = true;
        return [];
      }
    },
  };
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

async function createSession(
  model: string | Uint8Array,
): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = 1;
  const webGpuAvailable =
    typeof navigator !== 'undefined' && 'gpu' in navigator;
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: webGpuAvailable ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  };
  return typeof model === 'string'
    ? ort.InferenceSession.create(model, options)
    : ort.InferenceSession.create(model, options);
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
        tensor.data.byteLength / Uint16Array.BYTES_PER_ELEMENT,
      ),
    );
  throw new Error('Heron returned an unsupported output tensor.');
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
