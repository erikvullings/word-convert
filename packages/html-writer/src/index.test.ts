import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';
import { strFromU8, unzipSync } from 'fflate';
import { writeHtml, writeHtmlZip } from './index.ts';

function model(blocks: DocumentModel['blocks']): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      title: {
        value: 'A <safe> title',
        provenance: {
          source: 'test',
          method: 'extracted',
          confidence: 'certain',
        },
      },
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-07-15',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks,
    assets: {},
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}

describe('writeHtml', () => {
  it('writes deterministic semantic standalone HTML with a heading TOC', () => {
    const input = model([
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'One' }] },
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'Body' }] },
    ]);
    input.assets.font = {
      id: 'font',
      mediaType: 'font/woff2',
      data: new Uint8Array([119, 79, 70, 50]),
    };

    const first = writeHtml(input, {
      conversionDate: '2026-07-15',
      mode: 'standalone',
    });
    const second = writeHtml(input, {
      conversionDate: '2026-07-15',
      mode: 'standalone',
    });

    expect(first).toBe(second);
    expect(first).toContain('<!doctype html>');
    expect(first).toContain('<title>A &lt;safe&gt; title</title>');
    expect(first).toContain(
      '<main><h1 class="document-title">A &lt;safe&gt; title</h1>',
    );
    expect(first).toContain('<nav aria-label="Table of contents">');
    expect(first).toContain('<a href="#one">One</a>');
    expect(first).toContain('<a href="#one-2">One</a>');
    expect(first).toContain('<h1 id="one">One</h1>');
    expect(first).toContain('<h2 id="one-2">One</h2>');
    expect(first).toContain('@media (prefers-color-scheme: dark)');
    expect(first).toContain('figure{clear:both');
    expect(first).toContain('p>img{display:block');
    expect(first).toContain('@media print');
    expect(first).toContain('data:font/woff2;base64,d09GMg==');
  });

  it('does not duplicate a title already represented by a level-one heading', () => {
    const html = writeHtml(
      model([
        {
          type: 'heading',
          level: 1,
          children: [{ type: 'text', text: 'A <safe> title' }],
        },
      ]),
      { conversionDate: '2026-07-15', mode: 'fragment' },
    );

    expect(html).toContain('<h1 id="a-safe-title">A &lt;safe&gt; title</h1>');
    expect(html).not.toContain('class="document-title"');
  });

  it('serializes every supported block and inline node accessibly', () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' code', marks: [{ type: 'code' }] },
          { type: 'lineBreak' },
          { type: 'softBreak' },
          {
            type: 'link',
            href: 'https://example.com/a?x=1&y=2',
            children: [{ type: 'text', text: 'site' }],
          },
          { type: 'image', assetId: 'photo', alt: 'Photo' },
          { type: 'equation', equationId: 'eq' },
          { type: 'noteReference', noteId: 'note' },
        ],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          {
            blocks: [
              { type: 'paragraph', children: [{ type: 'text', text: 'Item' }] },
            ],
          },
        ],
      },
      {
        type: 'table',
        caption: [{ type: 'text', text: 'Data' }],
        rows: [
          {
            cells: [
              {
                header: true,
                colSpan: 2,
                rowSpan: 1,
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Head' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'blockquote',
        blocks: [
          { type: 'paragraph', children: [{ type: 'text', text: 'Quote' }] },
        ],
      },
      {
        type: 'codeBlock',
        language: 'ts" onclick="bad',
        text: '<script>alert(1)</script>',
      },
      { type: 'equationBlock', equationId: 'eq' },
      {
        type: 'imageBlock',
        assetId: 'photo',
        alt: 'Photo',
        caption: [{ type: 'text', text: 'Caption' }],
      },
      { type: 'thematicBreak' },
      { type: 'pageBreak' },
    ]);
    input.assets.photo = {
      id: 'photo',
      mediaType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71]),
      filename: '../../evil.png',
    };
    input.equations.eq = {
      id: 'eq',
      source: { format: 'tex', value: '<img src=x onerror=alert(1)>' },
      tex: 'x < y',
      conversionComplete: true,
    };
    input.notes.note = {
      id: 'note',
      kind: 'footnote',
      blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Note text' }] },
      ],
    };

    const html = writeHtml(input, {
      conversionDate: '2026-07-15',
      mode: 'fragment',
    });

    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code> code</code>');
    expect(html).toContain(
      '<a href="https://example.com/a?x=1&amp;y=2">site</a>',
    );
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(html).toContain('<ol start="3"><li><p>Item</p></li></ol>');
    expect(html).toContain('<caption>Data</caption>');
    expect(html).toContain('<th colspan="2" rowspan="1"><p>Head</p></th>');
    expect(html).toContain('<blockquote><p>Quote</p></blockquote>');
    expect(html).toContain(
      '<pre><code class="language-ts-onclick-bad">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    );
    expect(html).toContain(
      '<span class="equation" role="math">x &lt; y</span>',
    );
    expect(html).toContain('<figure><img');
    expect(html).toContain('<figcaption>Caption</figcaption>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<div class="page-break" aria-hidden="true"></div>');
    expect(html).toContain('<section class="notes" aria-label="Notes">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
  });

  it('makes active content inert and omits unsafe or remote-loading assets', () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: ' javascript:alert(1)',
            title: '" onmouseover="bad',
            children: [{ type: 'text', text: 'unsafe' }],
          },
          {
            type: 'link',
            href: 'data:text/html,<script>alert(1)</script>',
            children: [{ type: 'text', text: 'data' }],
          },
          { type: 'image', assetId: 'svg', alt: '"><script>alert(1)</script>' },
          { type: 'image', assetId: 'html', alt: 'html' },
        ],
      },
    ]);
    input.metadata.description = {
      value: '"><script src="https://evil.invalid/x.js"></script>',
      provenance: {
        source: 'test',
        method: 'extracted',
        confidence: 'certain',
      },
    };
    input.metadata.language = {
      value: 'en" onload="bad',
      provenance: {
        source: 'test',
        method: 'extracted',
        confidence: 'certain',
      },
    };
    input.assets.svg = {
      id: 'svg',
      mediaType: 'image/svg+xml',
      data: new TextEncoder().encode('<svg onload="alert(1)"/>'),
    };
    input.assets.html = {
      id: 'html',
      mediaType: 'text/html',
      data: new TextEncoder().encode('<script>alert(1)</script>'),
    };

    const html = writeHtml(input, { conversionDate: '2026-07-15' });

    expect(html).toContain('<html lang="en">');
    expect(html).toContain(
      'content="&quot;&gt;&lt;script src=&quot;https://evil.invalid/x.js&quot;&gt;&lt;/script&gt;"',
    );
    expect(html).toContain('<p>unsafedata</p>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('image/svg+xml');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('https://evil.invalid/x.js"></script>');
  });

  it('writes a deterministic HTML ZIP with generated safe POSIX asset paths', async () => {
    const input = model([
      { type: 'imageBlock', assetId: '../photo', alt: 'Photo' },
    ]);
    input.assets['../photo'] = {
      id: '../photo',
      mediaType: 'image/jpeg',
      filename: '..\\..\\active.html',
      data: new Uint8Array([255, 216, 255]),
    };
    input.assets['font/evil'] = {
      id: 'font/evil',
      mediaType: 'font/woff2',
      filename: '../../font.woff2',
      data: new Uint8Array([119, 79, 70, 50]),
    };

    const first = await writeHtmlZip(input, { conversionDate: '2026-07-15' });
    const second = await writeHtmlZip(input, { conversionDate: '2026-07-15' });
    const files = unzipSync(first);

    expect(first).toEqual(second);
    expect(Object.keys(files).sort()).toEqual([
      'document.html',
      'fonts/font-001.woff2',
      'images/image-001.jpg',
      'styles.css',
    ]);
    expect(strFromU8(files['document.html'] ?? new Uint8Array())).toContain(
      'src="images/image-001.jpg"',
    );
    expect(strFromU8(files['document.html'] ?? new Uint8Array())).toContain(
      'href="styles.css"',
    );
    expect(strFromU8(files['styles.css'] ?? new Uint8Array())).toContain(
      '@media print',
    );
    expect(
      Object.keys(files).every(
        (path) => !path.includes('..') && !path.includes('\\'),
      ),
    ).toBe(true);
  });
});
