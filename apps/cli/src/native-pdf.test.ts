import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';
import { loadNativeRuntime } from './native-runtime.ts';
import { createNativePdfAdapters } from './native-pdf.ts';
import { readPdf } from './pdf.ts';
import { isExecutionProvider } from './inference-options.ts';

const provider = process.env.WORDCONVERT_CLI_EXECUTION_PROVIDER ?? 'cpu';
if (!isExecutionProvider(provider))
  throw new Error('Invalid test execution provider.');

afterEach(() => vi.restoreAllMocks());

it.each(['auto', 'webgpu'] as const)(
  'only retries GPU initialization on CPU when selection is %s',
  async (selection) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'wordconvert-gpu-fallback-'),
    );
    try {
      const model = join(directory, 'model.onnx');
      await writeFile(model, 'model');
      const runtime = loadNativeRuntime();
      vi.spyOn(runtime.ort, 'listSupportedBackends').mockReturnValue([
        { name: 'cpu', bundled: true },
        { name: 'webgpu', bundled: true },
      ]);
      const session: InferenceSession = {
        inputNames: ['pixel_values'],
        outputNames: ['logits', 'pred_boxes'],
        inputMetadata: [
          {
            name: 'pixel_values',
            isTensor: true,
            type: 'float32',
            shape: [1, 3, 640, 640],
          },
        ],
        outputMetadata: [],
        run: async () => ({
          logits: new runtime.ort.Tensor(
            'float32',
            new Float32Array(17).fill(-100),
            [1, 1, 17],
          ),
          pred_boxes: new runtime.ort.Tensor(
            'float32',
            new Float32Array(4),
            [1, 1, 4],
          ),
        }),
        release: async () => undefined,
        startProfiling: () => undefined,
        endProfiling: () => undefined,
      };
      const create = vi
        .spyOn(runtime.ort.InferenceSession, 'create')
        .mockRejectedValueOnce(new Error('GPU driver unavailable'))
        .mockResolvedValue(session);
      const diagnostic = vi.fn();
      const bytes = await readFile(
        fileURLToPath(
          new URL(
            '../../../tests/fixtures/pdf/tagged-article.pdf',
            import.meta.url,
          ),
        ),
      );
      const operation = readPdf(bytes, 'article.pdf', {
        conversionDate: '2026-01-02',
        layoutModel: model,
        executionProvider: selection,
        onDiagnostic: diagnostic,
      });
      if (selection === 'auto') {
        expect((await operation).blocks.length).toBeGreaterThan(0);
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[1]?.[1]).toMatchObject({
          executionProviders: ['cpu'],
        });
        expect(diagnostic).toHaveBeenCalledWith(
          expect.stringContaining('Retrying on CPU'),
        );
      } else {
        await expect(operation).rejects.toThrow('GPU driver unavailable');
        expect(create).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['success', 'decoder-load-failure', 'decoder-release-failure'])(
  'releases shared native model sessions in reverse creation order (%s)',
  async (scenario) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'wordconvert-native-lifecycle-'),
    );
    try {
      await Promise.all(
        ['heron.onnx', 'encoder.onnx', 'decoder.onnx'].map((file) =>
          writeFile(join(directory, file), 'model'),
        ),
      );
      await writeFile(
        join(directory, 'tokenizer.json'),
        JSON.stringify({
          added_tokens: [
            { id: 0, content: '<s>', special: true },
            { id: 1, content: '<pad>', special: true },
            { id: 2, content: '</s>', special: true },
          ],
          model: { vocab: { '<s>': 0, '<pad>': 1, '</s>': 2, x: 3 } },
        }),
      );
      const releases: string[] = [];
      const session = (name: string): InferenceSession => ({
        inputNames: ['pixel_values'],
        outputNames: ['logits'],
        inputMetadata: [
          {
            name: 'pixel_values',
            isTensor: true,
            type: 'float32',
            shape: [1, 3, 640, 640],
          },
        ],
        outputMetadata: [],
        run: async () => ({}),
        release: async () => {
          await Promise.resolve();
          releases.push(name);
          if (scenario === 'decoder-release-failure' && name === 'decoder')
            throw new Error('release failed');
        },
        startProfiling: () => undefined,
        endProfiling: () => undefined,
      });
      const runtime = loadNativeRuntime();
      const create = vi
        .spyOn(runtime.ort.InferenceSession, 'create')
        .mockResolvedValueOnce(session('layout'))
        .mockResolvedValueOnce(session('encoder'));
      if (scenario === 'decoder-load-failure')
        create.mockRejectedValueOnce(new Error('decoder failed'));
      else create.mockResolvedValueOnce(session('decoder'));
      const operation = createNativePdfAdapters(runtime, {
        layoutModel: join(directory, 'heron.onnx'),
        formulaModelDir: directory,
      });
      if (scenario === 'decoder-load-failure') {
        await expect(operation).rejects.toThrow(
          'Could not load the requested TexTeller models.',
        );
        expect(releases).toEqual(['encoder', 'layout']);
      } else {
        const adapters = await operation;
        if (scenario === 'decoder-release-failure')
          await expect(adapters.dispose()).rejects.toThrow('release failed');
        else await adapters.dispose();
        expect(releases).toEqual(['decoder', 'encoder', 'layout']);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('renders PDF vectors through local native canvas without models', async () => {
  const bytes = await readFile(
    fileURLToPath(
      new URL(
        '../../../tests/fixtures/pdf/tagged-article.pdf',
        import.meta.url,
      ),
    ),
  );
  const model = await readPdf(bytes, 'article.pdf', {
    conversionDate: '2026-01-02',
    rasterize: true,
  });
  expect(model.blocks.length).toBeGreaterThan(0);
  expect(
    model.warnings.some((warning) => warning.code === 'cli-pdf-geometry-only'),
  ).toBe(false);
});

it('reports missing models instead of silently disabling requested ML', async () => {
  await expect(
    createNativePdfAdapters(loadNativeRuntime(), {
      layoutModel: 'missing-model.onnx',
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it.runIf(Boolean(process.env.WORDCONVERT_CLI_HERON_MODEL))(
  'runs real FP32 Heron inference using the selected native provider',
  async () => {
    const adapters = await createNativePdfAdapters(loadNativeRuntime(), {
      layoutModel: process.env.WORDCONVERT_CLI_HERON_MODEL!,
      executionProvider: provider,
    });
    try {
      const regions = await adapters.layoutDetector!.detect({
        width: 640,
        height: 640,
        rgba: new Uint8ClampedArray(640 * 640 * 4).fill(255),
      });
      expect(regions).toEqual(expect.any(Array));
    } finally {
      await adapters.dispose();
    }
  },
  120_000,
);

it.runIf(Boolean(process.env.WORDCONVERT_TEXTELLER_MODEL_DIR))(
  'runs real TexTeller encoder/decoder through the selected native provider',
  async () => {
    const adapters = await createNativePdfAdapters(loadNativeRuntime(), {
      formulaModelDir: process.env.WORDCONVERT_TEXTELLER_MODEL_DIR!,
      executionProvider: provider,
    });
    try {
      const rgba = new Uint8ClampedArray(128 * 88 * 4).fill(255);
      for (let y = 22; y < 64; y++)
        for (let x = 60; x < 64; x++) {
          const offset = (y * 128 + x) * 4;
          rgba[offset] = 0;
          rgba[offset + 1] = 0;
          rgba[offset + 2] = 0;
        }
      const result = await adapters.formulaRecognizer!.recognize({
        width: 128,
        height: 88,
        rgba,
      });
      expect(result.tex.length).toBeGreaterThan(0);
      expect(result.diagnostics?.backend).toBe(provider);
    } finally {
      await adapters.dispose();
    }
  },
  180_000,
);
