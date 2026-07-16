import { describe, expect, it } from 'vitest';

import { convertOmml, renderFormula, type NormalizedMath } from './index.ts';

const wrap = (body: string) =>
  `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</m:oMath>`;
const run = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;

describe('OMML formula conversion', () => {
  it('normalizes and serializes fractions, roots, scripts, matrices, and Unicode symbols', () => {
    const source = wrap(
      `<m:f><m:num>${run('α')}</m:num><m:den>${run('2')}</m:den></m:f>` +
        `<m:rad><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>` +
        `<m:sSubSup><m:e>${run('A')}</m:e><m:sub>${run('i')}</m:sub><m:sup>${run('2')}</m:sup></m:sSubSup>` +
        `<m:m><m:mr><m:e>${run('1')}</m:e><m:e>${run('2')}</m:e></m:mr><m:mr><m:e>${run('3')}</m:e><m:e>${run('∞')}</m:e></m:mr></m:m>`,
    );

    const result = convertOmml(source);

    expect(result.complete).toBe(true);
    expect(result.tex).toBe(
      String.raw`\frac{α}{2}\sqrt[3]{x}A_{i}^{2}\begin{matrix}1 & 2 \\ 3 & ∞\end{matrix}`,
    );
    expect(result.mathml).toContain('<mfrac><mi>α</mi><mn>2</mn></mfrac>');
    expect(result.mathml).toContain('<mroot><mi>x</mi><mn>3</mn></mroot>');
    expect(result.mathml).toContain(
      '<msubsup><mi>A</mi><mi>i</mi><mn>2</mn></msubsup>',
    );
    expect(result.mathml).toContain('<mtable>');
  });

  it('retains a safe diagnostic for unsupported OMML instead of disappearing', () => {
    const result = convertOmml(
      wrap(`<m:groupChr><m:e>${run('&lt;unsafe&gt;')}</m:e></m:groupChr>`),
    );

    expect(result.complete).toBe(false);
    expect(result.unsupported).toEqual(['groupChr']);
    expect(result.fallbackText).toContain('Unsupported formula (groupChr)');
    expect(result.fallbackText).not.toContain('<unsafe>');
  });

  it('renders all modes with accessible fallback and no active markup injection', () => {
    const math: NormalizedMath = {
      type: 'identifier',
      value: '<img onerror=alert(1)>',
    };

    expect(renderFormula(math, { mode: 'disabled', display: false })).toBe('');
    expect(
      renderFormula(math, { mode: 'source', display: false }),
    ).not.toContain('<img');
    expect(renderFormula(math, { mode: 'mathml', display: false })).toContain(
      '&lt;img',
    );
    const katex = renderFormula(math, { mode: 'katex', display: true });
    expect(katex).toContain('class="katex-display"');
    expect(katex).not.toMatch(/<img\b|onerror=["']|<script\b/i);
  });

  it('returns escaped fallback content when KaTeX rejects input', () => {
    const malicious: NormalizedMath = {
      type: 'text',
      value: String.raw`\href{javascript:alert(1)}{click}<script>`,
    };

    const output = renderFormula(malicious, { mode: 'katex', display: false });

    expect(output).not.toMatch(/href=["']javascript:|<script\b/i);
    expect(output).toContain('script');
  });
});
