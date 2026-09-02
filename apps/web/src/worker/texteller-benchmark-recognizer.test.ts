import { describe, expect, it, vi } from 'vitest';

import { createTexTellerBenchmarkRecognizer } from './texteller-benchmark-recognizer.ts';

describe('TexTeller benchmark recognizer', () => {
  it('implements the reader contract, validates output, and disposes the pipeline', async () => {
    const dispose = vi.fn(async () => undefined);
    const pipeline = Object.assign(
      vi.fn(async () => [{ generated_text: 'x^2' }]),
      { dispose },
    );
    const create = vi.fn((image) => image);
    const recognizer = createTexTellerBenchmarkRecognizer({
      load: async () => ({ pipeline, images: { create } }),
      validateTex: (tex) => tex === 'x^2',
    });
    const image = {
      width: 2,
      height: 2,
      rgba: new Uint8ClampedArray(16),
    };

    await expect(recognizer.prepare()).resolves.toBe(true);
    await expect(recognizer.recognize(image)).resolves.toEqual({ tex: 'x^2' });
    expect(create).toHaveBeenCalledWith(image);
    await Promise.all([recognizer.dispose(), recognizer.dispose()]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects invalid output and observes cancellation', async () => {
    const pipeline = Object.assign(
      vi.fn(async () => [{ generated_text: 'invalid{' }]),
      { dispose: vi.fn(async () => undefined) },
    );
    const recognizer = createTexTellerBenchmarkRecognizer({
      load: async () => ({ pipeline, images: { create: (image) => image } }),
      validateTex: () => false,
    });

    await expect(
      recognizer.recognize({
        width: 1,
        height: 1,
        rgba: new Uint8ClampedArray(4),
      }),
    ).rejects.toThrow('invalid TeX');
    await expect(
      recognizer.recognize(
        { width: 1, height: 1, rgba: new Uint8ClampedArray(4) },
        { cancellation: { cancelled: true } },
      ),
    ).rejects.toThrow('cancelled');
  });
});
