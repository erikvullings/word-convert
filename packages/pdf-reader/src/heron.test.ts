import { describe, expect, it } from 'vitest';
import { decodeHeronPostprocessedDetections } from './heron.ts';

describe('official postprocessed Heron detections', () => {
  it('decodes labels, threshold and pixel xyxy boxes into normalized regions', () => {
    const result = decodeHeronPostprocessedDetections(
      BigInt64Array.from([9n, 2n, 8n]),
      Float32Array.from([0.9, 0.8, 0.1]),
      Float32Array.from([64, 128, 320, 640, -64, 0, 128, 64, 0, 0, 640, 640]),
      0.6,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      label: 'text',
      x: 0.1,
      top: 0.2,
      width: 0.4,
      height: 0.8,
    });
    expect(result[1]).toMatchObject({
      label: 'formula',
      x: 0,
      top: 0,
      width: 0.2,
      height: 0.1,
    });
  });
  it('rejects malformed tensor sizes and invalid labels', () => {
    expect(() =>
      decodeHeronPostprocessedDetections(
        new BigInt64Array(1),
        new Float32Array(2),
        new Float32Array(4),
        0.6,
      ),
    ).toThrow('incompatible');
    expect(() =>
      decodeHeronPostprocessedDetections(
        BigInt64Array.from([99n]),
        Float32Array.from([0.9]),
        new Float32Array(4),
        0.6,
      ),
    ).toThrow('invalid');
  });
});
