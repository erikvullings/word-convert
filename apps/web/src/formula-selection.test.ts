import { describe, expect, it } from 'vitest';

import {
  adjustFormulaSelection,
  selectionScrollOffset,
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

  it('moves and resizes a selected region while keeping it on the page', () => {
    const bounds = { x: 0.2, top: 0.3, width: 0.4, height: 0.2 };
    expect(
      adjustFormulaSelection(
        bounds,
        { x: 0.3, top: 0.4 },
        { x: 0.95, top: 0.95 },
        'move',
      ),
    ).toEqual({ x: 0.6, top: 0.8, width: 0.4, height: 0.2 });
    expect(
      adjustFormulaSelection(
        bounds,
        { x: 0.2, top: 0.3 },
        { x: 0.1, top: 0.2 },
        'nw',
      ),
    ).toMatchObject({ x: 0.1, top: 0.2 });
    const resized = adjustFormulaSelection(
      bounds,
      { x: 0.2, top: 0.3 },
      { x: 0.1, top: 0.2 },
      'nw',
    );
    expect(resized.width).toBeCloseTo(0.5);
    expect(resized.height).toBeCloseTo(0.3);
    const minimum = adjustFormulaSelection(
      bounds,
      { x: 0.6, top: 0.5 },
      { x: 0.1, top: 0.1 },
      'se',
    );
    expect(minimum).toMatchObject({ x: 0.2, top: 0.3 });
    expect(minimum.width).toBeCloseTo(0.01);
    expect(minimum.height).toBeCloseTo(0.01);
  });

  it('centres the selected region in the scroll viewport', () => {
    expect(selectionScrollOffset(0.75, 1_600, 800)).toBe(800);
    expect(selectionScrollOffset(0.05, 1_600, 800)).toBe(0);
    expect(selectionScrollOffset(0.95, 1_600, 800)).toBe(800);
  });
});
