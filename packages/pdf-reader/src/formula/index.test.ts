import { describe, expect, it } from 'vitest';

import type { RawPdfTextSpan } from '../index.ts';
import {
  createFormulaCandidates,
  createManualFormulaCandidate,
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
    expect(
      reconstructSimpleTex([
        span('first-line', 'MultiHead(Q, K, V) = Concat(head)', 0.3, 0.2, {
          width: 0.4,
        }),
        span('second-line', 'where head = Attention(QW, KW, VW)', 0.36, 0.22, {
          width: 0.3,
        }),
      ]),
    ).toBeUndefined();
    expect(
      reconstructSimpleTex(
        ['FFN(', 'x', ') = max(0', ', xW', '+', 'b', ')', 'W', '+', 'b'].map(
          (text, index) =>
            span(`fragment-${index}`, text, 0.2 + index * 0.04, 0.2),
        ),
      ),
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

  it('does not promote an unmatched synthetic equation fragment', () => {
    const source = span('fraction', '1 / sqrt(d)', 0.4, 0.3, { width: 0.2 });
    const candidates = createFormulaCandidates({
      page: 3,
      spans: [source],
      renderedEquationRegions: [
        { x: 0.38, top: 0.28, width: 0.24, height: 0.06 },
      ],
    });

    expect(candidates).toEqual([]);
  });

  it('merges nearby rasterized formula fragments into the relational formula', () => {
    const relation = span('relation', 'y = x', 0.2, 0.3, { width: 0.1 });
    const fraction = span('fraction', '1 / √d', 0.37, 0.3, { width: 0.08 });

    const candidates = createFormulaCandidates({
      page: 4,
      spans: [relation, fraction],
      renderedEquationRegions: [
        { x: 0.36, top: 0.28, width: 0.1, height: 0.06 },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      spanIds: ['relation', 'fraction'],
      sources: expect.arrayContaining(['rasterized-equation']),
      requiresRecognition: true,
    });
    expect(candidates[0]?.bounds.x).toBeLessThanOrEqual(0.2);
    expect(candidates[0]?.bounds.x + candidates[0]!.bounds.width).toBeCloseTo(
      0.46,
    );
    expect(Object.keys(candidates[0]!.bounds).sort()).toEqual([
      'height',
      'top',
      'width',
      'x',
    ]);
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

  it('does not promote multiline prose containing inline equations', () => {
    const architectureProse = [
      span(
        'architecture-1',
        'The encoder has repeated layers. Each layer contains two sub-layers.',
        0.17,
        0.62,
        { width: 0.66 },
      ),
      span(
        'architecture-2',
        'The stack uses N = 6 identical layers with residual connections.',
        0.17,
        0.64,
        { width: 0.66 },
      ),
    ];
    const dotProductProse = [
      span(
        'dot-product-1',
        'To explain why products grow, assume independent variables with mean 0 and variance 1.',
        0.17,
        0.7,
        { width: 0.66 },
      ),
      span('dot-product-2', 'Then q · k =', 0.39, 0.72, { width: 0.14 }),
      span('sum', 'Σ', 0.54, 0.712, { width: 0.02 }),
      span('upper', 'd', 0.56, 0.706, { width: 0.01, fontSize: 7 }),
      span('lower', 'i=1', 0.56, 0.728, { width: 0.02, fontSize: 7 }),
      span(
        'dot-product-3',
        'q i k i and the result has mean 0 and variance d.',
        0.59,
        0.72,
        { width: 0.24 },
      ),
    ];

    expect(
      createFormulaCandidates({ page: 3, spans: architectureProse }),
    ).toEqual([]);
    expect(
      createFormulaCandidates({ page: 4, spans: dotProductProse }),
    ).toEqual([]);
  });

  it('rejects cross-column prose without losing a wide display equation', () => {
    const crossColumnProse = [
      span('left-1', 'of continuous representations', 0.176, 0.869, {
        width: 0.199,
      }),
      span('z', 'z', 0.382, 0.869, { width: 0.008 }),
      span('equals', '= (', 0.398, 0.869, { width: 0.027 }),
      span('z-prime', 'z', 0.425, 0.869, { width: 0.008 }),
      span('sequence-tail', ', ..., z', 0.44, 0.869, { width: 0.036 }),
      span('close', ')', 0.485, 0.869, { width: 0.006 }),
      span('period', '.', 0.491, 0.869, { width: 0.004 }),
      span('right-1', 'Given', 0.506, 0.869, { width: 0.04 }),
      span('right-z', 'z', 0.552, 0.869, { width: 0.008 }),
      span(
        'right-tail',
        ', the decoder then generates an output',
        0.56,
        0.869,
        { width: 0.263 },
      ),
      span('z-power', '1', 0.433, 0.875, { width: 0.006, fontSize: 7 }),
      span('z-end', 'n', 0.476, 0.875, { width: 0.008, fontSize: 7 }),
      span('left-3', 'sequence', 0.176, 0.883, { width: 0.061 }),
      span('left-open', '(', 0.242, 0.883, { width: 0.006 }),
      span('y', 'y', 0.248, 0.883, { width: 0.008 }),
      span('y-tail', ', ..., y', 0.263, 0.883, { width: 0.036 }),
      span('left-close', ')', 0.312, 0.883, { width: 0.006 }),
      span(
        'right-2',
        'of symbols one element at a time. At each step the model is auto-regressive',
        0.322,
        0.883,
        { width: 0.502 },
      ),
      span('y-start', '1', 0.256, 0.888, { width: 0.006, fontSize: 7 }),
      span('y-end', 'm', 0.299, 0.888, { width: 0.012, fontSize: 7 }),
    ];
    const learningRate = [
      span(
        'learning-rate',
        'lrate = d × min(step_num, step_num × warmup_steps)',
        0.266,
        0.779,
        { width: 0.468 },
      ),
    ];

    expect(
      createFormulaCandidates({ page: 2, spans: crossColumnProse }),
    ).toEqual([]);
    expect(
      createFormulaCandidates({ page: 7, spans: learningRate }),
    ).toHaveLength(1);
  });

  it('turns a manual region into the same reconstructable candidate shape', () => {
    const candidate = createManualFormulaCandidate(
      {
        id: 'pdf-equation-manual-p1-1000-2000-3000-1000',
        page: 1,
        kind: 'inline',
        bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
      },
      [span('equation', 'x = 5', 0.15, 0.22, { width: 0.12 })],
    );

    expect(candidate).toMatchObject({
      id: 'pdf-equation-manual-p1-1000-2000-3000-1000',
      sources: ['manual'],
      spanIds: ['equation'],
      tex: 'x = 5',
      requiresRecognition: false,
      confidence: 'medium',
    });

    const forced = createManualFormulaCandidate(
      {
        id: 'pdf-equation-image-p1-1000-2000-3000-1000',
        page: 1,
        kind: 'display',
        bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
        forceRecognition: true,
      },
      [span('equation', 'x = 5', 0.15, 0.22, { width: 0.12 })],
    );
    expect(forced).toMatchObject({
      tex: 'x = 5',
      requiresRecognition: true,
    });

    const typed = createManualFormulaCandidate(
      {
        id: 'pdf-equation-typed-p1-1000-2000-3000-1000',
        page: 1,
        kind: 'display',
        bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
        skipRecognition: true,
      },
      [],
    );
    expect(typed.requiresRecognition).toBe(false);
  });
});
