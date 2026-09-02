import { describe, expect, it, vi } from 'vitest';

import {
  createRapidLatexFormulaRecognizer,
  prepareFormulaInput,
  type FormulaModelSession,
  type FormulaRecognizerDependencies,
  type FormulaTensor,
} from './formula-recognizer.ts';

const tokenizer = JSON.stringify({
  added_tokens: [
    { id: 0, content: '[PAD]' },
    { id: 1, content: '[BOS]' },
    { id: 2, content: '[EOS]' },
  ],
  model: { vocab: { '[PAD]': 0, '[BOS]': 1, '[EOS]': 2, x: 3, Ġ: 4, '=': 5 } },
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

describe('RapidLatex formula recognizer', () => {
  it('initializes lazily once, falls back to WASM, and decodes until EOS', async () => {
    const releases: string[] = [];
    const generated = [3, 4, 5, 4, 3, 2];
    let decoderStep = 0;
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder' ? ['tokens', 'mask', 'context'] : ['input'],
      outputNames: ['output'],
      async run(feeds) {
        if (name === 'resizer')
          return { output: tensor('float32', new Float32Array([1]), [1, 1]) };
        if (name === 'encoder')
          return {
            output: tensor('float32', new Float32Array([0.5]), [1, 1, 1]),
          };
        const tokenCount = feeds.tokens!.dims[1]!;
        if (tokenCount === 1) decoderStep = 0;
        const logits = new Float32Array(tokenCount * 6).fill(-10);
        logits[(tokenCount - 1) * 6 + generated[decoderStep++]!] = 10;
        return { output: tensor('float32', logits, [1, tokenCount, 6]) };
      },
      release: () => releases.push(name),
    });
    const createSession = vi.fn(async (model: string, provider: string) => {
      if (provider === 'webgpu') throw new Error('WebGPU unavailable');
      return session(model);
    });
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: 'resizer',
        encoder: 'encoder',
        decoder: 'decoder',
        tokenizer,
      },
      { dependencies: dependencies(createSession), maxTokens: 16 },
    );

    expect(createSession).not.toHaveBeenCalled();
    const image = {
      width: 2,
      height: 1,
      rgba: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    };
    await expect(recognizer.recognize(image)).resolves.toEqual({
      tex: 'x=x',
      diagnostics: { backend: 'wasm', tokens: 6 },
    });
    await expect(recognizer.recognize(image)).resolves.toMatchObject({
      tex: 'x=x',
    });
    expect(createSession).toHaveBeenCalledTimes(4);

    await recognizer.dispose();
    expect(releases.sort()).toEqual(['decoder', 'encoder', 'resizer']);
  });

  it('checks cancellation before inference', async () => {
    const createSession = vi.fn();
    const recognizer = createRapidLatexFormulaRecognizer(
      { imageResizer: '', encoder: '', decoder: '', tokenizer },
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

  it('composites transparency onto white and pads model input to 32 pixels', () => {
    const prepared = prepareFormulaInput({
      width: 2,
      height: 1,
      rgba: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]),
    });

    expect(prepared.width).toBe(32);
    expect(prepared.height).toBe(32);
    expect(prepared.data[0]).toBeCloseTo((255 - 0.7931 * 255) / (0.1738 * 255));
  });

  it('bounds generation and checks cancellation between decoder steps', async () => {
    const cancellation = { cancelled: false };
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder' ? ['tokens', 'mask', 'context'] : ['input'],
      outputNames: ['output'],
      async run() {
        if (name === 'resizer')
          return { output: tensor('float32', new Float32Array([1]), [1, 1]) };
        if (name === 'encoder')
          return { output: tensor('float32', new Float32Array([1]), [1, 1]) };
        cancellation.cancelled = true;
        return {
          output: tensor('float32', new Float32Array([0, 0, 0, 1]), [1, 1, 4]),
        };
      },
      release() {},
    });
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: 'resizer',
        encoder: 'encoder',
        decoder: 'decoder',
        tokenizer,
      },
      {
        dependencies: dependencies(async (model) => session(String(model))),
        maxTokens: 2,
      },
    );

    await expect(
      recognizer.recognize(
        {
          width: 1,
          height: 1,
          rgba: new Uint8ClampedArray([255, 255, 255, 255]),
        },
        { cancellation },
      ),
    ).rejects.toThrow('cancelled');
  });

  it('rejects invalid TeX and releases partially initialized sessions', async () => {
    const released = vi.fn();
    const inputSession: FormulaModelSession = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => ({
        output: tensor('float32', new Float32Array([1]), [1]),
      }),
      release: released,
    };
    const createSession = vi
      .fn<FormulaRecognizerDependencies['createSession']>()
      .mockResolvedValueOnce(inputSession)
      .mockRejectedValueOnce(new Error('encoder failed'));
    const recognizer = createRapidLatexFormulaRecognizer(
      { imageResizer: '', encoder: '', decoder: '', tokenizer },
      {
        dependencies: {
          ...dependencies(createSession),
          webGpuAvailable: () => false,
          validateTex: () => false,
        },
      },
    );

    await expect(recognizer.prepare()).resolves.toBe(false);
    expect(released).toHaveBeenCalledOnce();
  });

  it('fails when the decoder does not emit EOS within the token limit', async () => {
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder' ? ['tokens', 'mask', 'context'] : ['input'],
      outputNames: ['output'],
      async run(feeds) {
        if (name === 'resizer')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        if (name === 'encoder')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        const tokenCount = feeds.tokens!.dims[1]!;
        const logits = new Float32Array(tokenCount * 4);
        logits[(tokenCount - 1) * 4 + 3] = 1;
        return {
          output: tensor('float32', logits, [1, tokenCount, 4]),
        };
      },
      release() {},
    });
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: 'resizer',
        encoder: 'encoder',
        decoder: 'decoder',
        tokenizer,
      },
      {
        dependencies: dependencies(async (model) => session(String(model))),
        maxTokens: 2,
      },
    );

    await expect(
      recognizer.recognize({
        width: 1,
        height: 1,
        rgba: new Uint8ClampedArray([255, 255, 255, 255]),
      }),
    ).rejects.toThrow('token limit');
  });

  it('rejects decoded output that fails strict TeX validation', async () => {
    let decoderStep = 0;
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder' ? ['tokens', 'mask', 'context'] : ['input'],
      outputNames: ['output'],
      async run(feeds) {
        if (name === 'resizer')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        if (name === 'encoder')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        const tokenCount = feeds.tokens!.dims[1]!;
        const logits = new Float32Array(tokenCount * 6).fill(-1);
        logits[(tokenCount - 1) * 6 + [3, 2][decoderStep++]!] = 1;
        return {
          output: tensor('float32', logits, [1, tokenCount, 6]),
        };
      },
      release() {},
    });
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: 'resizer',
        encoder: 'encoder',
        decoder: 'decoder',
        tokenizer,
      },
      {
        dependencies: {
          ...dependencies(async (model) => session(String(model))),
          validateTex: () => false,
        },
      },
    );

    await expect(
      recognizer.recognize({
        width: 1,
        height: 1,
        rgba: new Uint8ClampedArray([255, 255, 255, 255]),
      }),
    ).rejects.toThrow('invalid TeX');
  });

  it('rejects decoder IDs missing from the pinned tokenizer', async () => {
    let decoderStep = 0;
    const session = (name: string): FormulaModelSession => ({
      inputNames:
        name === 'decoder' ? ['tokens', 'mask', 'context'] : ['input'],
      outputNames: ['output'],
      async run(feeds) {
        if (name === 'resizer')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        if (name === 'encoder')
          return {
            output: tensor('float32', new Float32Array([1]), [1, 1]),
          };
        const tokenCount = feeds.tokens!.dims[1]!;
        const logits = new Float32Array(tokenCount * 8).fill(-1);
        logits[(tokenCount - 1) * 8 + [7, 2][decoderStep++]!] = 1;
        return {
          output: tensor('float32', logits, [1, tokenCount, 8]),
        };
      },
      release() {},
    });
    const recognizer = createRapidLatexFormulaRecognizer(
      {
        imageResizer: 'resizer',
        encoder: 'encoder',
        decoder: 'decoder',
        tokenizer,
      },
      { dependencies: dependencies(async (model) => session(String(model))) },
    );

    await expect(
      recognizer.recognize({
        width: 1,
        height: 1,
        rgba: new Uint8ClampedArray([255, 255, 255, 255]),
      }),
    ).rejects.toThrow('no token 7');
  });
});
