import { describe, expect, it } from 'vitest';
import type { Equation } from '@wordconvert/document-model';
import type {
  PdfFormulaCandidate,
  PdfFormulaDecision,
} from '@wordconvert/pdf-reader';

import {
  formulaReviewItems,
  moveFormulaSelection,
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
    expect(validateFormulaDraft('x^2')).toMatchObject({
      valid: true,
      html: expect.stringContaining('katex'),
    });
    expect(validateFormulaDraft('\\frac{x{y}')).toEqual({
      valid: false,
      error: 'Enter valid LaTeX before saving.',
    });
    expect(validateFormulaDraft('   ')).toEqual({
      valid: false,
      error: 'LaTeX is required.',
    });
  });
});
