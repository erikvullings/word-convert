import { readFile, stat } from 'node:fs/promises';
import {
  createHeronLayoutDetector,
  createTexTellerRecognizer,
  float16ToFloat32,
  type FormulaModelSession,
  type FormulaTensor,
  type FormulaTensorType,
  type HeronLayoutDetector,
  type PdfFigureRasterizer,
  type TexTellerBenchmarkRecognizer,
} from '@wordconvert/pdf-reader';
import { isValidTex } from '@wordconvert/math-converter';
import { join } from 'node:path';
import type { NativeRuntime } from './native-runtime.ts';
import {
  nativeSessionOptions,
  type ExecutionProvider,
} from './inference-options.ts';

export interface NativePdfOptions {
  layoutModel?: string;
  formulaModelDir?: string;
  executionProvider?: ExecutionProvider;
}

export async function createNativePdfAdapters(
  runtime: NativeRuntime,
  options: NativePdfOptions,
) {
  const { canvas, ort } = runtime;
  const provider = options.executionProvider ?? 'cpu';
  const sessionOptions = nativeSessionOptions(
    provider,
    ort.listSupportedBackends(),
  );
  let layoutDetector: HeronLayoutDetector | undefined;
  let formulaRecognizer: TexTellerBenchmarkRecognizer | undefined;
  try {
    if (options.layoutModel) {
      await validateModelFile(options.layoutModel);
      layoutDetector = createHeronLayoutDetector(options.layoutModel, {
        strict: true,
        async createSession(model) {
          const session =
            typeof model === 'string'
              ? await ort.InferenceSession.create(model, sessionOptions)
              : await ort.InferenceSession.create(model, sessionOptions);
          const metadata = session.inputMetadata[0];
          const postprocessed =
            metadata?.isTensor &&
            metadata.type === 'uint8' &&
            metadata.name === 'images' &&
            session.inputNames.includes('orig_target_sizes');
          if (
            !postprocessed &&
            (!metadata?.isTensor || metadata.type !== 'float32')
          ) {
            await session.release();
            throw new Error(
              'Native Heron requires FP32 input. Export it with scripts/export-heron-onnx.py --fp32 --output <path>. Bun native bindings do not support Float16Array input.',
            );
          }
          return {
            async run(data) {
              const input = postprocessed
                ? new ort.Tensor(
                    'uint8',
                    Uint8Array.from(data, (value) => Math.round(value * 255)),
                    [1, 3, 640, 640],
                  )
                : new ort.Tensor('float32', data, [1, 3, 640, 640]);
              const sizes = postprocessed
                ? new ort.Tensor(
                    'int64',
                    BigInt64Array.from([640n, 640n]),
                    [1, 2],
                  )
                : undefined;
              let outputs:
                | import('onnxruntime-node').InferenceSession.OnnxValueMapType
                | undefined;
              try {
                outputs = await session.run(
                  sizes
                    ? { images: input, orig_target_sizes: sizes }
                    : { pixel_values: input },
                );
                if (postprocessed) {
                  const labels = outputs.labels;
                  if (
                    !labels ||
                    labels.type !== 'int64' ||
                    !(labels.data instanceof BigInt64Array)
                  )
                    throw new Error('Heron returned invalid labels.');
                  return {
                    labels: new BigInt64Array(labels.data),
                    scores: floatOutput(outputs.scores),
                    boxes: floatOutput(outputs.boxes),
                  };
                }
                return {
                  logits: floatOutput(outputs.logits),
                  boxes: floatOutput(outputs.pred_boxes),
                };
              } finally {
                input.dispose();
                sizes?.dispose();
                for (const output of Object.values(outputs ?? {}))
                  output.dispose();
              }
            },
            release: () => session.release(),
          };
        },
      });
      if (!(await layoutDetector.prepare()))
        throw new Error('Could not load the requested Heron model.');
    }
    if (options.formulaModelDir) {
      const encoder = join(options.formulaModelDir, 'encoder.onnx');
      const decoder = join(options.formulaModelDir, 'decoder.onnx');
      const tokenizerPath = join(options.formulaModelDir, 'tokenizer.json');
      await Promise.all([
        validateModelFile(encoder),
        validateModelFile(decoder),
        validateModelFile(tokenizerPath, 10 * 1024 * 1024),
      ]);
      formulaRecognizer = createTexTellerRecognizer(
        {
          encoder,
          decoder,
          tokenizer: await readFile(tokenizerPath, 'utf8'),
        },
        {
          dependencies: {
            fallbackBackend: provider,
            webGpuAvailable: () => false,
            createTensor: (type, data, dims) => ({ type, data, dims }),
            validateTex: isValidTex,
            async createSession(model): Promise<FormulaModelSession> {
              const session =
                typeof model === 'string'
                  ? await ort.InferenceSession.create(model, sessionOptions)
                  : await ort.InferenceSession.create(model, sessionOptions);
              return {
                inputNames: session.inputNames,
                outputNames: session.outputNames,
                async run(feeds) {
                  const inputs: Record<
                    string,
                    import('onnxruntime-node').Tensor
                  > = {};
                  for (const [name, tensor] of Object.entries(feeds))
                    inputs[name] = new ort.Tensor(tensor.type, tensor.data, [
                      ...tensor.dims,
                    ]);
                  let outputs:
                    | import('onnxruntime-node').InferenceSession.OnnxValueMapType
                    | undefined;
                  try {
                    outputs = await session.run(inputs);
                    return Object.fromEntries(
                      Object.entries(outputs).map(([name, tensor]) => [
                        name,
                        formulaOutput(tensor),
                      ]),
                    );
                  } finally {
                    for (const input of Object.values(inputs)) input.dispose();
                    for (const output of Object.values(outputs ?? {}))
                      output.dispose();
                  }
                },
                release: () => session.release(),
              };
            },
          },
        },
      );
      if (!(await formulaRecognizer.prepare()))
        throw new Error('Could not load the requested TexTeller models.');
    }
    const figureRasterizer: PdfFigureRasterizer = {
      CanvasFactory: class {
        create(width: number, height: number) {
          const surface = canvas.createCanvas(width, height);
          return { canvas: surface, context: surface.getContext('2d') };
        }
        reset(
          target: { canvas: import('@napi-rs/canvas').Canvas },
          width: number,
          height: number,
        ) {
          target.canvas.width = width;
          target.canvas.height = height;
        }
        destroy(target: {
          canvas: import('@napi-rs/canvas').Canvas | null;
          context: unknown;
        }) {
          if (target.canvas) {
            target.canvas.width = 0;
            target.canvas.height = 0;
          }
          target.canvas = null;
          target.context = null;
        }
      },
      FilterFactory: class {
        addFilter() {
          return 'none';
        }
        addHCMFilter() {
          return 'none';
        }
        addAlphaFilter() {
          return 'none';
        }
        addLuminosityFilter() {
          return 'none';
        }
        addKnockoutFilter() {
          return 'none';
        }
        addHighlightHCMFilter() {
          return 'none';
        }
        addSelectionHCMFilter() {
          return 'none';
        }
        addSelectionFilter() {
          return 'none';
        }
        createSelectionStyle() {
          return null;
        }
        destroy() {}
      },
      createSurface(width, height) {
        if (width * height > 40_000_000)
          throw new Error('PDF surface exceeds the 40 megapixel limit.');
        const surface = canvas.createCanvas(width, height);
        return {
          canvas: surface,
          readRgba: () =>
            surface.getContext('2d').getImageData(0, 0, width, height).data,
          encodePng: async () => new Uint8Array(await surface.encode('png')),
          dispose: () => {
            surface.width = 0;
            surface.height = 0;
          },
        };
      },
    };
    return {
      figureRasterizer,
      ...(layoutDetector ? { layoutDetector } : {}),
      ...(formulaRecognizer ? { formulaRecognizer } : {}),
      async dispose() {
        try {
          await formulaRecognizer?.dispose();
        } finally {
          await layoutDetector?.dispose();
        }
      },
    };
  } catch (error) {
    try {
      await formulaRecognizer?.dispose();
    } finally {
      await layoutDetector?.dispose();
    }
    throw error;
  }
}

async function validateModelFile(path: string, limit = 1024 * 1024 * 1024) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > limit)
    throw new Error(
      `Model file must be nonempty and at most ${limit} bytes: ${path}`,
    );
}

function floatOutput(
  tensor: import('onnxruntime-node').Tensor | undefined,
): Float32Array {
  if (!tensor)
    throw new Error('Heron did not return its required output tensors.');
  if (tensor.data instanceof Float32Array) return tensor.data.slice();
  if (tensor.type === 'float16' && tensor.data instanceof Uint16Array)
    return float16ToFloat32(tensor.data);
  throw new Error('Heron returned an unsupported tensor type.');
}

function formulaOutput(
  tensor: import('onnxruntime-node').Tensor,
): FormulaTensor {
  let type: FormulaTensorType;
  if (
    tensor.type === 'float32' ||
    tensor.type === 'int64' ||
    tensor.type === 'bool'
  )
    type = tensor.type;
  else throw new Error('TexTeller returned an unsupported tensor type.');
  if (!(
    tensor.data instanceof Float32Array ||
    tensor.data instanceof BigInt64Array ||
    tensor.data instanceof Uint8Array
  ))
    throw new Error('TexTeller returned incompatible tensor data.');
  return { type, data: tensor.data.slice(), dims: [...tensor.dims] };
}
