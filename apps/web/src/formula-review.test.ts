import { describe, expect, it } from 'vitest';
import type { Equation } from '@wordconvert/document-model';
import type {
  PdfFormulaCandidate,
  PdfFormulaDecision,
} from '@wordconvert/pdf-reader';

import {
  formulaReviewItems,
  moveFormulaSelection,
  normalizeFormulaTex,
  validateFormulaDraft,
} from './formula-review.ts';

const candidate = (
  id: string,
  confidence: PdfFormulaCandidate['confidence'],
): PdfFormulaCandidate => ({
  id,
  page: 1,
  kind: 'inline',
  bounds: { x: 0.1, top: 0.2, width: 0.2, height: 0.05 },
  spanIds: [`${id}-span`],
  features: {
    mathFontRatio: 1,
    operatorRatio: 0.2,
    greekRatio: 0,
    symbolRatio: 0,
    singleLetterTokenRatio: 0.5,
    dictionaryLikeWordRatio: 0,
    superscriptCount: 0,
    subscriptCount: 0,
    baselineVariance: 0,
    fontSizeVariance: 0,
    centered: false,
    isolated: false,
    equationNumberAtRight: false,
    multilineStructure: false,
    score: 4,
    confidence,
  },
  score: 4,
  confidence,
  sources: ['geometry'],
  tex: id,
  requiresRecognition: false,
});

const equation = (id: string): Equation => ({
  id,
  source: { format: 'tex', value: id },
  tex: id,
  conversionComplete: true,
  display: 'inline',
  recognition: { method: 'pdf-text', confidence: 0.9 },
  review: { status: 'unreviewed' },
});

describe('formula review', () => {
  it('filters typed decisions by review status and keeps detected TeX for reset', () => {
    const candidates = [candidate('a', 'high'), candidate('b', 'medium')];
    const equations = { a: equation('a'), b: equation('b') };
    const decisions: Record<string, PdfFormulaDecision> = {
      a: {
        equationId: 'a',
        decision: 'formula',
        tex: 'a^2',
      },
      b: {
        equationId: 'b',
        decision: 'formula',
        accepted: true,
      },
    };

    expect(
      formulaReviewItems(candidates, equations, decisions, 'edited'),
    ).toEqual([
      expect.objectContaining({ id: 'a', status: 'edited', detectedTex: 'a' }),
    ]);
    expect(
      formulaReviewItems(candidates, equations, decisions, 'accepted'),
    ).toEqual([expect.objectContaining({ id: 'b', status: 'accepted' })]);
    decisions.a = { ...decisions.a!, accepted: true };
    expect(
      formulaReviewItems(candidates, equations, decisions, 'accepted'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'a',
          currentTex: 'a^2',
          status: 'accepted',
        }),
      ]),
    );
    expect(moveFormulaSelection(['a', 'b'], 'a', 1)).toBe('b');
    expect(moveFormulaSelection(['a', 'b'], 'b', 1)).toBe('a');
  });

  it('returns safe preview markup only for valid non-empty TeX', () => {
    const valid = validateFormulaDraft('x^2');
    expect(valid).toMatchObject({
      valid: true,
      html: expect.stringContaining('<math'),
    });
    expect(validateFormulaDraft('\\frac{x{y}')).toEqual({
      valid: false,
      error: 'Enter valid LaTeX before saving.',
    });
    expect(validateFormulaDraft('   ')).toEqual({
      valid: false,
      error: 'LaTeX is required.',
    });
    expect(
      validateFormulaDraft('\\mathrm{where\\;head_i}', true),
    ).toMatchObject({
      valid: true,
      html: expect.stringContaining('mathrm'),
    });
    expect(validateFormulaDraft('x\\tag{1}')).toMatchObject({ valid: false });
    expect(validateFormulaDraft('x\\tag{1}', true)).toMatchObject({
      valid: true,
      html: expect.stringContaining('tag'),
    });
  });

  it('shows a typed draft as edited before analysis is rerun', () => {
    const item = formulaReviewItems(
      [candidate('missing', 'low')],
      {},
      {},
      'all',
      { missing: 'x + y' },
    )[0];

    expect(item).toMatchObject({
      currentTex: 'x + y',
      status: 'edited',
    });
  });

  it('prefers requested recognition over stale reconstructed TeX', () => {
    const recognized = {
      ...candidate('stale', 'medium'),
      tex: 'QK = dk',
      requiresRecognition: true,
      recognition: {
        tex: '\\frac{QK}{d_k}',
        model: 'texteller-onnx-q4',
        reviewConfidence: 'medium' as const,
      },
    };

    expect(formulaReviewItems([recognized], {}, {}, 'all')[0]).toMatchObject({
      detectedTex: '\\frac{QK}{d_k}',
      currentTex: '\\frac{QK}{d_k}',
    });
  });

  it('includes detected equation images without inventing LaTeX', () => {
    const image = {
      id: 'pdf-equation-1-0',
      page: 1,
      bounds: { x: 0.2, top: 0.3, width: 0.4, height: 0.08 },
    };

    expect(formulaReviewItems([], {}, {}, 'all', {}, [image])).toEqual([
      expect.objectContaining({
        id: image.id,
        kind: 'image',
        image,
        detectedTex: '',
        currentTex: '',
        status: 'needs-review',
      }),
    ]);
    expect(
      formulaReviewItems(
        [],
        {},
        { [image.id]: { equationId: image.id, decision: 'image' } },
        'accepted',
        {},
        [image],
      ),
    ).toEqual([expect.objectContaining({ id: image.id, status: 'accepted' })]);

    const promoted = {
      ...candidate(image.id, 'medium'),
      sourceImageId: image.id,
      bounds: { x: 0.15, top: 0.25, width: 0.5, height: 0.12 },
    };
    expect(formulaReviewItems([promoted], {}, {}, 'all', {}, [image])).toEqual([
      expect.objectContaining({
        id: image.id,
        kind: 'image',
        image: expect.objectContaining({ bounds: promoted.bounds }),
      }),
    ]);
  });

  it('normalizes newline-separated TeX as an aligned display formula', () => {
    expect(normalizeFormulaTex('a &= b\nc &= d')).toBe(
      '\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',
    );
    expect(validateFormulaDraft('a &= b\nc &= d', true)).toMatchObject({
      valid: true,
      tex: '\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',
      html: expect.stringContaining('<mtable'),
    });
  });
});
