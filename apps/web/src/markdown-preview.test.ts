import { describe, expect, it } from 'vitest';

import { renderMarkdownPreview } from './markdown-preview.ts';

describe('Markdown preview rendering', () => {
  it('renders inline and block math through the KaTeX Slimdown extension', () => {
    const html = renderMarkdownPreview(
      'Inline $x^2$\n\n$$\n\\frac{QK^T}{\\sqrt{d_k}}\n$$',
    );

    expect(html).toContain('<math');
    expect(html).toContain('display="block"');
    expect(html).toContain('<mfrac>');
    expect(html).not.toContain('style=');
  });

  it('falls back safely when math is invalid', () => {
    const html = renderMarkdownPreview('$\\frac{x{y}<script>$');

    expect(html).toContain('katex-error');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
