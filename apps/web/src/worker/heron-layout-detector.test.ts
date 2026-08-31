import { describe, expect, it } from 'vitest';

import {
  createHeronLayoutDetector,
  decodeHeronDetections,
  float16ToFloat32,
  float32ToFloat16,
  rgbaToHeronInput,
} from './heron-layout-detector.ts';

describe('Heron layout detector', () => {
  it('converts RGBA pixels to rescaled planar RGB input', () => {
    const input = rgbaToHeronInput(
      new Uint8ClampedArray([255, 128, 0, 255, 64, 32, 16, 128]),
      2,
      1,
    );

    expect(input).toEqual(
      new Float32Array([1, 64 / 255, 128 / 255, 32 / 255, 0, 16 / 255]),
    );
  });

  it('rejects page images that do not match Heron input geometry', async () => {
    const detector = createHeronLayoutDetector(new Uint8Array());

    await expect(
      detector.detect({
        width: 2,
        height: 1,
        rgba: new Uint8ClampedArray(8),
      }),
    ).rejects.toThrow('Heron requires a 640 by 640 page image.');
  });

  it('falls back to no proposals when model initialization fails', async () => {
    const detector = createHeronLayoutDetector(new Uint8Array());
    const image = {
      width: detector.inputSize,
      height: detector.inputSize,
      rgba: new Uint8ClampedArray(detector.inputSize * detector.inputSize * 4),
    };

    await expect(detector.detect(image)).resolves.toEqual([]);
    await expect(detector.detect(image)).resolves.toEqual([]);
  });

  it('round-trips model tensors through IEEE-754 half floats', () => {
    const values = new Float32Array([0, 1, -2, 0.5, 0.1, 65_504]);

    expect(Array.from(float16ToFloat32(float32ToFloat16(values)))).toEqual([
      0,
      1,
      -2,
      0.5,
      expect.closeTo(0.1, 3),
      65_504,
    ]);
  });

  it('decodes confident RT-DETR labels and normalized center boxes', () => {
    const logits = new Float32Array(2 * 17).fill(-10);
    logits[6] = 2;
    logits[17 + 8] = 1;
    const boxes = new Float32Array([0.5, 0.4, 0.6, 0.2, 0.25, 0.6, 0.4, 0.5]);

    expect(decodeHeronDetections(logits, boxes, 0.7)).toEqual([
      {
        label: 'picture',
        confidence: expect.closeTo(0.8808, 4),
        x: expect.closeTo(0.2, 4),
        top: expect.closeTo(0.3, 4),
        width: expect.closeTo(0.6, 4),
        height: expect.closeTo(0.2, 4),
      },
      {
        label: 'table',
        confidence: expect.closeTo(0.7311, 4),
        x: expect.closeTo(0.05, 4),
        top: expect.closeTo(0.35, 4),
        width: expect.closeTo(0.4, 4),
        height: expect.closeTo(0.5, 4),
      },
    ]);
  });

  it('clips boxes to page bounds and rejects malformed tensors', () => {
    const logits = new Float32Array(17).fill(-10);
    logits[8] = 4;

    expect(
      decodeHeronDetections(
        logits,
        new Float32Array([0.05, 0.5, 0.2, 1.4]),
        0.7,
      ),
    ).toEqual([
      expect.objectContaining({
        x: 0,
        top: 0,
        width: expect.closeTo(0.15, 6),
        height: 1,
      }),
    ]);
    expect(() =>
      decodeHeronDetections(logits, new Float32Array(3), 0.7),
    ).toThrow('Heron returned incompatible detection tensors.');
  });
});
