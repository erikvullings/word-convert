import type { RawPdfTextSpan } from '../index.ts';

const GREEK: Readonly<Record<string, string>> = {
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\epsilon',
  θ: '\\theta',
  λ: '\\lambda',
  μ: '\\mu',
  π: '\\pi',
  ρ: '\\rho',
  σ: '\\sigma',
  τ: '\\tau',
  φ: '\\phi',
  ψ: '\\psi',
  ω: '\\omega',
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Θ: '\\Theta',
  Λ: '\\Lambda',
  Π: '\\Pi',
  Σ: '\\Sigma',
  Φ: '\\Phi',
  Ψ: '\\Psi',
  Ω: '\\Omega',
};
const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
};
const SUBSCRIPTS: Readonly<Record<string, string>> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
};
const MAX_SIMPLE_SPANS = 8;

export function reconstructSimpleTex(
  spans: readonly RawPdfTextSpan[],
): string | undefined {
  if (spans.length === 0) return undefined;
  const source = spans.map(({ text }) => text).join(' ');
  if (/[∫∑Σ∏Π√]|\\(?:frac|begin)/u.test(source)) return undefined;
  const ordered = [...spans].sort((left, right) => left.x - right.x);
  const ordinary = ordered.filter(({ text }) => text.trim());
  if (ordinary.length > MAX_SIMPLE_SPANS) return undefined;
  const normalSize = Math.max(...ordinary.map(({ fontSize }) => fontSize));
  const normalBaselines = ordinary
    .filter(({ fontSize }) => fontSize >= normalSize * 0.85)
    .map((span) => span.baseline ?? span.top + span.height * 0.8);
  if (Math.max(...normalBaselines) - Math.min(...normalBaselines) >= 0.012)
    return undefined;
  const normalBaseline = Math.max(...normalBaselines);
  const pieces = ordered.map((span) => {
    const value = normalizeSymbols(span.text.trim());
    if (!value) return '';
    const baseline = span.baseline ?? span.top + span.height * 0.8;
    if (span.fontSize < normalSize * 0.85 && baseline < normalBaseline - 0.004)
      return `^${brace(value)}`;
    if (span.fontSize < normalSize * 0.85 && baseline > normalBaseline + 0.004)
      return `_${brace(value)}`;
    return value;
  });
  return pieces
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([_^])/g, '$1')
    .trim();
}

function normalizeSymbols(value: string): string {
  let output = '';
  for (const character of value) {
    if (GREEK[character]) output += GREEK[character];
    else if (SUPERSCRIPTS[character]) output += `^${SUPERSCRIPTS[character]}`;
    else if (SUBSCRIPTS[character]) output += `_${SUBSCRIPTS[character]}`;
    else if (character === '−' || character === '–') output += '-';
    else if (character === '×' || character === '·') output += '\\times ';
    else if (character === '÷') output += '\\div ';
    else if (character === '≤') output += '\\le ';
    else if (character === '≥') output += '\\ge ';
    else if (character === '≠') output += '\\ne ';
    else if (character === '→') output += '\\to ';
    else output += character;
  }
  return output.replace(/\s+/g, ' ').trim();
}

function brace(value: string): string {
  return value.length === 1 ? value : `{${value}}`;
}
