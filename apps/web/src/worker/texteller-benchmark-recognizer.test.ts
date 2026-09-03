import { describe, expect, it, vi } from 'vitest';

import type {
  FormulaModelSession,
  FormulaRecognizerDependencies,
  FormulaTensor,
} from './formula-model-runtime.ts';
import {
  createTexTellerBenchmarkRecognizer,
  normalizeTexTellerLatex,
  prepareTexTellerInput,
  splitTexTellerRows,
} from './texteller-benchmark-recognizer.ts';

const tokenizer = JSON.stringify({
  added_tokens: [
    { id: 0, content: '<s>', special: true },
    { id: 1, content: '<pad>', special: true },
    { id: 2, content: '</s>', special: true },
  ],
  model: { vocab: { '<s>': 0, '<pad>': 1, '</s>': 2, x: 3, Ġ: 4, '=': 5 } },
});

function tensor(
  type: FormulaTensor['type'],
  data: FormulaTensor['data'],
  dims: readonly number[],
): FormulaTensor {
  return { type, data, dims };
}

function dependencies(
  createSession: FormulaRecognizerDependencies['createSession'],
): FormulaRecognizerDependencies {
  return {
    webGpuAvailable: () => true,
    createSession,
    createTensor: tensor,
    validateTex: () => true,
  };
}

describe('TexTeller benchmark recognizer', () => {
  it('loads direct ONNX sessions, falls back to WASM, and decodes until EOS', async () => {
    const releases: string[] = [];
    const generated = [3, 4, 5, 4, 3, 2];
    let decoderStep = 0;
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder'
          ? ['input_ids', 'encoder_hidden_states']
          : ['pixel_values'],
      outputNames: [name === 'decoder' ? 'logits' : 'last_hidden_state'],
      async run(feeds) {
        if (name === 'encoder') {
          expect(feeds.pixel_values?.dims).toEqual([1, 1, 448, 448]);
          return {
            last_hidden_state: tensor(
              'float32',
              new Float32Array([0.5]),
              [1, 1, 1],
            ),
          };
        }
        const tokenCount = feeds.input_ids!.dims[1]!;
        if (tokenCount === 1)
          expect(feeds.input_ids?.data).toEqual(BigInt64Array.from([0n]));
        const logits = new Float32Array(tokenCount * 6).fill(-10);
        logits[(tokenCount - 1) * 6 + generated[decoderStep++]!] = 10;
        return { logits: tensor('float32', logits, [1, tokenCount, 6]) };
      },
      release: () => releases.push(name),
    });
    const createSession = vi.fn(async (model: string, provider: string) => {
      if (provider === 'webgpu') throw new Error('WebGPU unavailable');
      return session(model);
    });
    const recognizer = createTexTellerBenchmarkRecognizer(
      { encoder: 'encoder', decoder: 'decoder', tokenizer },
      { dependencies: dependencies(createSession), maxTokens: 16 },
    );

    expect(createSession).not.toHaveBeenCalled();
    await expect(
      recognizer.recognize({
        width: 2,
        height: 1,
        rgba: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
      }),
    ).resolves.toEqual({
      tex: 'x=x',
      diagnostics: { backend: 'wasm', tokens: 6 },
    });
    expect(createSession).toHaveBeenCalledTimes(3);

    await Promise.all([recognizer.dispose(), recognizer.dispose()]);
    expect(releases.sort()).toEqual(['decoder', 'encoder']);
  });

  it('trims the background, preserves aspect ratio, and pads normalized input', () => {
    const rgba = new Uint8ClampedArray(8 * 4 * 4).fill(255);
    for (let row = 1; row < 3; row++)
      for (let column = 2; column < 6; column++) {
        const offset = (row * 8 + column) * 4;
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
      }

    const prepared = prepareTexTellerInput({ width: 8, height: 4, rgba });

    expect(prepared.width).toBe(448);
    expect(prepared.height).toBe(448);
    expect(prepared.data).toHaveLength(448 * 448);
    let minimum = Number.POSITIVE_INFINITY;
    for (const value of prepared.data) minimum = Math.min(minimum, value);
    expect(minimum).toBeCloseTo(-0.9545467 / 0.15394445);
    expect(prepared.data.at(-1)).toBe(0);
  });

  it('splits separated full-width ink rows but keeps narrow scripts together', () => {
    const image = inkImage(100, 50, [
      { left: 10, top: 5, width: 80, height: 8 },
      { left: 12, top: 32, width: 76, height: 8 },
    ]);
    const scripted = inkImage(100, 30, [
      { left: 10, top: 12, width: 80, height: 8 },
      { left: 78, top: 3, width: 8, height: 5 },
    ]);

    expect(splitTexTellerRows(image)).toHaveLength(2);
    expect(splitTexTellerRows(scripted)).toEqual([scripted]);
  });

  it('observes cancellation before loading', async () => {
    const createSession = vi.fn();
    const recognizer = createTexTellerBenchmarkRecognizer(
      { encoder: '', decoder: '', tokenizer },
      { dependencies: dependencies(createSession) },
    );

    await expect(
      recognizer.recognize(
        { width: 1, height: 1, rgba: new Uint8ClampedArray(4) },
        { cancellation: { cancelled: true } },
      ),
    ).rejects.toThrow('cancelled');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('removes outer math delimiters before validation', () => {
    expect(normalizeTexTellerLatex(' \\[ x + y = z \\] ')).toBe('x+y=z');
    expect(normalizeTexTellerLatex('$$x^2$$')).toBe('x^2');
  });
});

function inkImage(
  width: number,
  height: number,
  regions: readonly {
    left: number;
    top: number;
    width: number;
    height: number;
  }[],
) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const region of regions)
    for (let row = region.top; row < region.top + region.height; row++)
      for (
        let column = region.left;
        column < region.left + region.width;
        column++
      ) {
        const offset = (row * width + column) * 4;
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
      }
  return { width, height, rgba };
}
