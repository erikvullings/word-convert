import { describe, expect, it } from 'vitest';

import {
  manualFormulaRegionId,
  normalizeFormulaSelection,
  pointInPreview,
} from './formula-selection.ts';

describe('manual formula selection', () => {
  it('normalizes pointer coordinates and clamps reversed selections to the page', () => {
    expect(
      pointInPreview(250, 150, { left: 50, top: 50, width: 400, height: 200 }),
    ).toEqual({
      x: 0.5,
      top: 0.5,
    });
    expect(
      normalizeFormulaSelection({ x: 0.8, top: 1.2 }, { x: -0.2, top: 0.4 }),
    ).toEqual({ x: 0, top: 0.4, width: 0.8, height: 0.6 });
    expect(
      normalizeFormulaSelection({ x: 0.2, top: 0.2 }, { x: 0.205, top: 0.3 }),
    ).toBeUndefined();
  });

  it('derives a stable page-specific ID from quantized normalized bounds', () => {
    const bounds = { x: 0.12344, top: 0.2, width: 0.3, height: 0.1 };
    expect(manualFormulaRegionId(2, bounds)).toBe(
      manualFormulaRegionId(2, { ...bounds, x: 0.123441 }),
    );
    expect(manualFormulaRegionId(2, bounds)).not.toBe(
      manualFormulaRegionId(3, bounds),
    );
  });
});
