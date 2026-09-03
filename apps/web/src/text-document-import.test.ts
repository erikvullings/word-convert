// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  importTextDocument,
  importTextDocumentWithSource,
} from './text-document-import.ts';

describe('text document import', () => {
  it('imports the article rather than page chrome and preserves LaTeXML formulas', () => {
    const imported = importTextDocumentWithSource(
      `<!doctype html><html lang="en"><head><title>Browser title</title>
        <meta name="citation_title" content="Attention Is All You Need">
        <meta name="citation_author" content="Ashish Vaswani">
      </head><body><nav>Site navigation</nav><article class="ltx_document">
        <h1>Attention Is All You Need</h1>
        <p>Scale by <math alttext="\\sqrt{d_{k}}" display="inline">
          <msqrt><msub><mi>d</mi><mi>k</mi></msub></msqrt>
        </math>.</p>
        <table class="ltx_equation"><tbody><tr><td><math alttext="\\mathrm{Attention}(Q,K,V)" display="block"><mi>A</mi></math></td><td>(1)</td></tr></tbody></table>
        <a href="mailto:">Author</a>
        <img src="https://tracker.example/pixel" onerror="alert(1)" alt="Figure">
        <script>alert(1)</script>
      </article><footer>Site footer</footer></body></html>`,
      'html',
      {
        sourceUrl: 'https://arxiv.org/html/1706.03762v7',
        filename: '1706.03762v7.html',
        conversionDate: '2026-09-03',
      },
    );
    const model = imported.model;

    expect(model.metadata.title?.value).toBe('Attention Is All You Need');
    expect(model.metadata.authors[0]?.value.name).toBe('Ashish Vaswani');
    expect(JSON.stringify(model.blocks)).not.toContain('Site navigation');
    expect(Object.values(model.equations)).toMatchObject([
      { tex: '\\sqrt{d_{k}}', display: 'inline' },
      { tex: '\\mathrm{Attention}(Q,K,V)', display: 'block' },
    ]);
    expect(JSON.stringify(model.blocks)).toContain('equationId');
    expect(imported.sourceHtml?.html).toContain('class="ltx_equation"');
    expect(imported.sourceHtml?.html).toContain('<math');
    expect(imported.sourceHtml?.html).not.toContain('<script');
    expect(imported.sourceHtml?.html).not.toContain('onerror');
    expect(imported.sourceHtml?.html).not.toContain('tracker.example');
    expect(imported.sourceHtml?.html).not.toContain('mailto:');
    expect(imported.sourceHtml?.html).toContain('>Figure</span>');
    expect(imported.sourceHtml?.xhtml).toContain(
      'xmlns="http://www.w3.org/1998/Math/MathML"',
    );
    expect(imported.sourceHtml?.xhtml).not.toMatch(/<math[^>]*>\s+</);
  });

  it('imports Markdown and plain text without HTML parsing', () => {
    const markdown = importTextDocument(
      '# Heading\n\nA **bold** paragraph with $x^2$.\n\n$$\\sqrt{d_k}$$',
      'markdown',
      {
        filename: 'notes.md',
        conversionDate: '2026-09-03',
      },
    );
    const text = importTextDocument(
      'First paragraph.\n\nLiteral # marker.',
      'text',
      {
        filename: 'notes.txt',
        conversionDate: '2026-09-03',
      },
    );

    expect(markdown.blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(Object.values(markdown.equations)).toMatchObject([
      { tex: 'x^2', display: 'inline' },
      { tex: '\\sqrt{d_k}', display: 'block' },
    ]);
    expect(text.blocks).toHaveLength(2);
    expect(text.blocks[1]).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'text', text: 'Literal # marker.' }],
    });
  });
});
