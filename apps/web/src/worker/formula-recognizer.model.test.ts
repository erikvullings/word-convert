import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { createRapidLatexFormulaRecognizer } from './formula-recognizer.ts';

const asset = (name: string) =>
  fileURLToPath(new URL(`../assets/formula-ocr/${name}`, import.meta.url));

it.runIf(process.env.WORDCONVERT_TEST_FORMULA_MODEL === '1')(
  'loads the pinned RapidLatexOCR graphs through ONNX Runtime Web',
  async () => {
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: await readFile(asset('image_resizer.onnx')),
        encoder: await readFile(asset('encoder.onnx')),
        decoder: await readFile(asset('decoder.onnx')),
        tokenizer: await readFile(asset('tokenizer.json'), 'utf8'),
      },
      { maxTokens: 8 },
    );

    await expect(recognizer.prepare()).resolves.toBe(true);
    try {
      const result = await recognizer.recognize({
        width: 32,
        height: 32,
        rgba: new Uint8ClampedArray(32 * 32 * 4).fill(255),
      });
      expect(result.tex).not.toBe('');
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toMatch(
        /^Formula recognition (?:returned (?:empty|invalid) TeX|exceeded its token limit)\.$/,
      );
    }
    await recognizer.dispose();
  },
  120_000,
);
