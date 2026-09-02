import { describe, expect, it } from 'vitest';

import type { RawPdfTextSpan } from '../index.ts';
import {
  createFormulaCandidates,
  extractMathFeatures,
  padFormulaBounds,
  reconstructSimpleTex,
} from './index.ts';

function span(
  id: string,
  text: string,
  x: number,
  top: number,
  overrides: Partial<RawPdfTextSpan> = {},
): RawPdfTextSpan {
  return {
    id,
    text,
    x,
    top,
    width: 0.04,
    height: 0.02,
    baseline: top + 0.016,
    fontId: 'pdf-font-times-regular-roman',
    fontFamily: 'Times',
    fontSize: 11,
    bold: false,
    italic: false,
    direction: 'ltr',
    ...overrides,
  };
}

describe('PDF formula domain', () => {
  it('scores structural math evidence without classifying prose or a lone italic variable', () => {
    const formula = [
      span('x', 'x', 0.35, 0.3, { italic: true }),
      span('equals', '=', 0.4, 0.3),
      span('alpha', 'α', 0.45, 0.3, {
        fontFamily: 'ABCDEF+STIXTwoMath',
      }),
      span('two', '2', 0.49, 0.292, { fontSize: 7 }),
    ];

    expect(extractMathFeatures(formula, { pageWidth: 1 })).toMatchObject({
      mathFontRatio: 0.25,
      operatorRatio: 0.25,
      greekRatio: 0.25,
      superscriptCount: 1,
    });
    expect(
      extractMathFeatures(formula, { pageWidth: 1 }).score,
    ).toBeGreaterThan(
      extractMathFeatures(
        [span('prose', 'A centered section heading', 0.35, 0.3)],
        { pageWidth: 1 },
      ).score,
    );
    expect(
      extractMathFeatures(
        [span('variable', 'v', 0.35, 0.3, { italic: true })],
        { pageWidth: 1 },
      ).confidence,
    ).toBe('low');
  });

  it('reconstructs supported Unicode and geometry scripts but delegates complex structures', () => {
    expect(reconstructSimpleTex([span('plain', 'x² − α × y₁', 0.2, 0.2)])).toBe(
      'x^2 - \\alpha \\times y_1',
    );
    expect(
      reconstructSimpleTex([
        span('x', 'x', 0.2, 0.2),
        span('power', '2', 0.24, 0.19, { fontSize: 7 }),
        span('equals', '=', 0.28, 0.2),
        span('five', '5', 0.32, 0.2),
      ]),
    ).toBe('x^2 = 5');
    expect(
      reconstructSimpleTex([span('integral', '∫₀¹ x dx', 0.2, 0.2)]),
    ).toBeUndefined();
  });

  it('fuses Heron and geometry evidence with stable reading-order IDs', () => {
    const spans = [
      span('x', 'x', 0.35, 0.3),
      span('plus', '+', 0.39, 0.3),
      span('y', 'y', 0.43, 0.3),
      span('equals', '=', 0.47, 0.3),
      span('five', '5', 0.51, 0.3),
    ];
    const candidates = createFormulaCandidates({
      page: 12,
      spans,
      layoutRegions: [
        {
          label: 'formula',
          confidence: 0.8,
          x: 0.34,
          top: 0.29,
          width: 0.23,
          height: 0.04,
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'pdf-equation-p12-001',
      page: 12,
      sources: expect.arrayContaining(['heron', 'geometry', 'symbols']),
      spanIds: ['x', 'plus', 'y', 'equals', 'five'],
    });
    const belowThreshold = createFormulaCandidates({
      page: 12,
      spans,
      layoutRegions: [
        {
          label: 'formula',
          confidence: 0.59,
          x: 0.34,
          top: 0.29,
          width: 0.23,
          height: 0.04,
        },
      ],
    });
    expect(belowThreshold[0]?.sources).not.toContain('heron');
  });

  it('keeps nearby equations distinct and padding inside the page', () => {
    const spans = [
      span('first', 'x = 1', 0.1, 0.1, { width: 0.1 }),
      span('second', 'y = 2', 0.7, 0.1, { width: 0.1 }),
    ];
    expect(createFormulaCandidates({ page: 1, spans })).toHaveLength(2);
    expect(
      padFormulaBounds({ x: 0.001, top: 0.002, width: 0.998, height: 0.997 }),
    ).toEqual({ x: 0, top: 0, width: 1, height: 1 });
  });
});
