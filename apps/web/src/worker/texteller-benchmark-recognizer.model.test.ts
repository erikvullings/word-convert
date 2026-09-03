import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import { browserFormulaRecognizerDependencies } from './formula-model-runtime.ts';
import { createTexTellerBenchmarkRecognizer } from './texteller-benchmark-recognizer.ts';

const modelDirectory = process.env.WORDCONVERT_TEXTELLER_MODEL_DIR;

it.runIf(Boolean(modelDirectory))(
  'loads and runs pinned TexTeller graphs through ONNX Runtime Web',
  async () => {
    const recognizer = createTexTellerBenchmarkRecognizer(
      {
        encoder: await readFile(resolve(modelDirectory!, 'encoder.onnx')),
        decoder: await readFile(resolve(modelDirectory!, 'decoder.onnx')),
        tokenizer: await readFile(
          resolve(modelDirectory!, 'tokenizer.json'),
          'utf8',
        ),
      },
      {
        dependencies: {
          ...browserFormulaRecognizerDependencies,
          validateTex: () => true,
        },
        maxTokens: 64,
      },
    );

    await expect(recognizer.prepare()).resolves.toBe(true);
    try {
      const result = await recognizer.recognize(crossImage());
      expect(result.tex).not.toBe('');
      expect(result.diagnostics?.tokens).toBeGreaterThan(0);
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toMatch(
        /^TexTeller recognition exceeded its token limit \(tokens: [\d,]+\)\.$/,
      );
    }
    await recognizer.dispose();
  },
  180_000,
);

function crossImage() {
  const width = 128;
  const height = 88;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let offset = 0; offset < 42; offset++) {
    drawPixel(rgba, width, 42 + offset, 22 + offset);
    drawPixel(rgba, width, 83 - offset, 22 + offset);
  }
  return { width, height, rgba };
}

function drawPixel(
  rgba: Uint8ClampedArray,
  width: number,
  centerX: number,
  centerY: number,
): void {
  for (let y = centerY - 2; y <= centerY + 2; y++)
    for (let x = centerX - 2; x <= centerX + 2; x++) {
      const offset = (y * width + x) * 4;
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
    }
}
