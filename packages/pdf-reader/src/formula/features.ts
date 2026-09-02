import type { RawPdfTextSpan } from '../index.ts';
import type { PdfMathFeatures } from './types.ts';

export const PDF_FORMULA_WEIGHTS = {
  mathFont: 2.5,
  operator: 2,
  greek: 1.5,
  symbol: 1,
  singleLetter: 0.75,
  scripts: 1.75,
  multipleBaselines: 1.25,
  centered: 0.75,
  equationNumber: 1,
  heron: 3,
  dictionaryWord: -2.5,
} as const;

export const PDF_FORMULA_THRESHOLDS = {
  heronConfidence: 0.6,
  mediumScore: 2.25,
  highScore: 4.5,
  baselineDisplacement: 0.004,
  fusionCoverage: 0.65,
} as const;

const MATH_FONT =
  /(?:CMMI|CMSY|CMEX|LatinModernMath|STIX(?:Two)?Math|CambriaMath|MathJax|TeXGyre(?:Termes|Pagella)Math)/i;
const OPERATOR = /[=+\-−×÷*/<>≤≥≈≠→←↔]/u;
const GREEK = /[Α-ωϐ-Ͽ]/u;
const STRUCTURAL_SYMBOL = /[()[\]{}√∑Σ∏Π∫∂∞^_]/u;

export function normalizePdfFontName(value: string): string {
  return value.replace(/^[A-Z]{6}\+/, '');
}

export function extractMathFeatures(
  spans: readonly RawPdfTextSpan[],
  context: {
    pageWidth?: number;
    isolated?: boolean;
    heronFormulaConfidence?: number;
  } = {},
): PdfMathFeatures {
  const nonempty = spans.filter(({ text }) => text.trim());
  const count = Math.max(nonempty.length, 1);
  const tokens = nonempty.flatMap(({ text }) => text.trim().split(/\s+/));
  const baselines = nonempty.map(
    (span) => span.baseline ?? span.top + span.height * 0.8,
  );
  const baselineMean = mean(baselines);
  const sizes = nonempty.map(({ fontSize }) => fontSize);
  const sizeMean = mean(sizes);
  const scriptSpans = nonempty.filter(
    (span) =>
      span.fontSize < sizeMean * 0.85 &&
      Math.abs(
        (span.baseline ?? span.top + span.height * 0.8) - baselineMean,
      ) >= PDF_FORMULA_THRESHOLDS.baselineDisplacement,
  );
  const superscriptCount = scriptSpans.filter(
    (span) => (span.baseline ?? span.top + span.height * 0.8) < baselineMean,
  ).length;
  const subscriptCount = scriptSpans.length - superscriptCount;
  const mathFontRatio =
    nonempty.filter((span) =>
      MATH_FONT.test(
        normalizePdfFontName(`${span.fontFamily ?? ''} ${span.fontId}`),
      ),
    ).length / count;
  const operatorRatio =
    nonempty.filter(({ text }) => OPERATOR.test(text)).length / count;
  const greekRatio =
    nonempty.filter(({ text }) => GREEK.test(text)).length / count;
  const symbolRatio =
    nonempty.filter(({ text }) => STRUCTURAL_SYMBOL.test(text)).length / count;
  const singleLetterTokenRatio =
    tokens.filter((token) => /^[A-Za-zΑ-ω]$/u.test(token)).length /
    Math.max(tokens.length, 1);
  const dictionaryLikeWordRatio =
    tokens.filter((token) => /^[A-Za-z]{3,}$/.test(token)).length /
    Math.max(tokens.length, 1);
  const left =
    nonempty.length > 0 ? Math.min(...nonempty.map(({ x }) => x)) : 0;
  const right =
    nonempty.length > 0
      ? Math.max(...nonempty.map(({ x, width }) => x + width))
      : 0;
  const centered =
    Math.abs((left + right) / 2 - (context.pageWidth ?? 1) / 2) <= 0.1;
  const equationNumberAtRight = nonempty.some(
    ({ text, x }) => /^\(\d+[a-z]?\)$/i.test(text.trim()) && x >= 0.65,
  );
  const baselineVariance = variance(baselines);
  const fontSizeVariance = variance(sizes);
  const isolated = context.isolated ?? false;
  const multilineStructure = baselineVariance >= 0.00002;
  const score =
    PDF_FORMULA_WEIGHTS.mathFont * mathFontRatio +
    PDF_FORMULA_WEIGHTS.operator * operatorRatio +
    PDF_FORMULA_WEIGHTS.greek * greekRatio +
    PDF_FORMULA_WEIGHTS.symbol * symbolRatio +
    PDF_FORMULA_WEIGHTS.singleLetter * singleLetterTokenRatio +
    PDF_FORMULA_WEIGHTS.scripts * Number(scriptSpans.length > 0) +
    PDF_FORMULA_WEIGHTS.multipleBaselines * Number(multilineStructure) +
    PDF_FORMULA_WEIGHTS.centered * Number(centered && isolated) +
    PDF_FORMULA_WEIGHTS.equationNumber * Number(equationNumberAtRight) +
    PDF_FORMULA_WEIGHTS.heron * (context.heronFormulaConfidence ?? 0) +
    PDF_FORMULA_WEIGHTS.dictionaryWord * dictionaryLikeWordRatio;
  const confidence =
    score >= PDF_FORMULA_THRESHOLDS.highScore
      ? 'high'
      : score >= PDF_FORMULA_THRESHOLDS.mediumScore
        ? 'medium'
        : 'low';
  return {
    mathFontRatio,
    operatorRatio,
    greekRatio,
    symbolRatio,
    singleLetterTokenRatio,
    dictionaryLikeWordRatio,
    superscriptCount,
    subscriptCount,
    baselineVariance,
    fontSizeVariance,
    centered,
    isolated,
    equationNumberAtRight,
    multilineStructure,
    ...(context.heronFormulaConfidence !== undefined
      ? { heronFormulaConfidence: context.heronFormulaConfidence }
      : {}),
    score,
    confidence,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const average = mean(values);
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
        values.length;
}
