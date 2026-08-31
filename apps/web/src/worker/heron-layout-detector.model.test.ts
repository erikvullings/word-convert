import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { createHeronLayoutDetector } from './heron-layout-detector.ts';

const modelPath = fileURLToPath(
  new URL('../assets/heron/model_fp16.onnx', import.meta.url),
);

it.runIf(process.env.WORDCONVERT_TEST_HERON_MODEL === '1')(
  'runs the bundled Heron model through ONNX Runtime Web',
  async () => {
    const detector = createHeronLayoutDetector(await readFile(modelPath));
    const regions = await detector.detect({
      width: detector.inputSize,
      height: detector.inputSize,
      rgba: new Uint8ClampedArray(
        detector.inputSize * detector.inputSize * 4,
      ).fill(255),
    });

    expect(regions).toEqual(expect.any(Array));
    for (const region of regions) {
      expect(region.confidence).toBeGreaterThanOrEqual(0.6);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.top).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(1);
      expect(region.top + region.height).toBeLessThanOrEqual(1);
    }
  },
  120_000,
);
