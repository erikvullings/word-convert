// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  importTextDocument,
  importRemoteTextDocumentWithSource,
  sanitizeEditedSourceHtml,
} from './text-document-import.ts';

describe('text document import', () => {
  it('imports the article rather than page chrome and preserves LaTeXML formulas', async () => {
    const imported = await importRemoteTextDocumentWithSource(
      `<!doctype html><html lang="en"><head><title>Browser title</title>
        <meta name="citation_title" content="Attention Is All You Need">
        <meta name="citation_author" content="Ashish Vaswani">
        <style>@import "https://tracker.example/x.css"; .ltx_p { color: #123; background: url(https://tracker.example/pixel) } @font-face { src: url(font.woff2) }</style>
      </head><body><nav>Site navigation</nav><article class="ltx_document">
        <h1>Attention Is All You Need</h1>
        <p>Scale by <math alttext="\\sqrt{d_{k}}" display="inline">
          <msqrt><msub><mi>d</mi><mi>k</mi></msub></msqrt>
        </math>.</p>
        <table class="ltx_equation"><tbody><tr><td><math alttext="\\mathrm{Attention}(Q,K,V)" display="block"><mi>A</mi></math></td><td>(1)</td></tr></tbody></table>
        <a href="mailto:">Author</a>
        <img src="figure.png" onerror="alert(1)" alt="Figure">
        <script>alert(1)</script>
      </article><footer>Site footer</footer></body></html>`,
      'html',
      {
        sourceUrl: 'https://arxiv.org/html/1706.03762v7',
        filename: '1706.03762v7.html',
        conversionDate: '2026-09-03',
        resources: [
          {
            url: 'https://arxiv.org/html/figure.png',
            mediaType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
          },
        ],
        stylesheets: ['.ltx_authors { display: grid }'],
      },
    );
    const model = imported.model;

    expect(model.metadata.title?.value).toBe(
      'Attention Is All You Need [1706.03762]',
    );
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
    expect(imported.sourceHtml?.html).not.toContain('mailto:');
    expect(imported.sourceHtml?.html).toContain(
      'src="data:image/png;base64,AQID"',
    );
    expect(imported.sourceHtml?.xhtml).toContain(
      'src="wordconvert-asset:remote-image-0001"',
    );
    expect(imported.sourceHtml?.css).toContain('.ltx_p{color:#123}');
    expect(imported.sourceHtml?.css).toContain('.ltx_authors{display:grid}');
    expect(imported.sourceHtml?.css).not.toContain('tracker.example');
    expect(imported.sourceHtml?.css).not.toContain('@font-face');
    expect(imported.model.assets['remote-image-0001']?.data).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(imported.sourceHtml?.xhtml).toContain(
      'xmlns="http://www.w3.org/1998/Math/MathML"',
    );
    expect(imported.sourceHtml?.xhtml).not.toMatch(/<math[^>]*>\s+</);
  });

  it('prefers a descriptive arXiv heading over identifier-only metadata', async () => {
    const imported = await importRemoteTextDocumentWithSource(
      `<!doctype html><html><head>
        <title>[1706.03762] Attention Is All You Need</title>
        <meta name="citation_title" content="1706.03762">
      </head><body><article class="ltx_document">
        <h1>Attention Is All You Need</h1>
      </article></body></html>`,
      'html',
      {
        sourceUrl: 'https://arxiv.org/html/1706.03762v7',
        filename: '1706.03762v7.html',
        conversionDate: '2026-09-03',
      },
    );

    expect(imported.model.metadata.title?.value).toBe(
      'Attention Is All You Need [1706.03762]',
    );
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

  it('re-sanitizes source edits while retaining managed images', () => {
    const assets = {
      figure: {
        id: 'figure',
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      },
    };
    const source = sanitizeEditedSourceHtml(
      '<article><script>alert(1)</script><img src="wordconvert-asset:figure"><img src="https://tracker.example/pixel"></article>',
      assets,
      '.article{color:#123}',
    );

    expect(source?.html).not.toContain('<script');
    expect(source?.html).not.toContain('tracker.example');
    expect(source?.html).toContain('data:image/png;base64,AQID');
    expect(source?.xhtml).toContain('wordconvert-asset:figure');
    expect(source?.css).toBe('.article{color:#123}');
  });
});
