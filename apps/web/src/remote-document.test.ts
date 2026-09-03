// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  fetchRemoteDocument,
  fetchRemoteHtmlImages,
  fetchRemoteHtmlStylesheets,
  normalizeRemoteDocumentUrl,
} from './remote-document.ts';

describe('remote document loading', () => {
  it('prefers arXiv HTML for abstract and PDF links', () => {
    expect(
      normalizeRemoteDocumentUrl('https://arxiv.org/abs/1706.03762v7'),
    ).toBe('https://arxiv.org/html/1706.03762v7');
    expect(
      normalizeRemoteDocumentUrl('https://arxiv.org/pdf/1706.03762v7.pdf'),
    ).toBe('https://arxiv.org/html/1706.03762v7');
    expect(
      normalizeRemoteDocumentUrl('https://arxiv.org/html/1706.03762v7'),
    ).toBe('https://arxiv.org/html/1706.03762v7');
  });

  it.each([
    ['text/html; charset=utf-8', 'article.html', 'html'],
    ['text/markdown', 'notes.md', 'markdown'],
    ['text/plain', 'notes.txt', 'text'],
  ] as const)(
    'loads %s as a %s document',
    async (mediaType, filename, format) => {
      const fetcher = vi.fn(async () =>
        Promise.resolve(
          new Response('Document body', {
            headers: {
              'content-type': mediaType,
              'content-disposition': `inline; filename="${filename}"`,
            },
          }),
        ),
      );

      const result = await fetchRemoteDocument(
        'https://example.com/document',
        fetcher,
      );

      expect(result).toMatchObject({
        filename,
        format,
        content: 'Document body',
      });
    },
  );

  it('keeps valid PDF responses as file imports', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nfixture');
    const result = await fetchRemoteDocument(
      'https://example.com/paper.pdf',
      async () =>
        new Response(bytes, {
          headers: { 'content-type': 'application/pdf' },
        }),
    );

    expect(result.format).toBe('pdf');
    if (result.format !== 'pdf') throw new Error('Expected a PDF response.');
    expect(result.file.type).toBe('application/pdf');
  });

  it('fetches only bounded same-origin HTML images', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const resources = await fetchRemoteHtmlImages(
      '<img src="figure.png"><img src="https://tracker.example/pixel.png">',
      'https://arxiv.org/html/1234.5678',
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://arxiv.org/html/figure.png',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(resources).toMatchObject([
      { url: 'https://arxiv.org/html/figure.png', mediaType: 'image/png' },
    ]);
  });

  it('ignores arXiv page chrome when discovering article resources', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    const html = `<html><head><link rel="stylesheet" href="/static/arxiv.css"></head><body>
      <header><img src="/static/arxiv-logo.svg"></header>
      <article class="ltx_document"><img src="figure.png"></article>
      <footer><img src="/static/funder.png"></footer>
    </body></html>`;

    const [images, stylesheets] = await Promise.all([
      fetchRemoteHtmlImages(html, 'https://arxiv.org/html/1234.5678', fetcher),
      fetchRemoteHtmlStylesheets(
        html,
        'https://arxiv.org/html/1234.5678',
        fetcher,
      ),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://arxiv.org/html/figure.png',
      expect.anything(),
    );
    expect(images).toHaveLength(1);
    expect(stylesheets).toEqual([]);
  });

  it('skips an unavailable image without failing the document', async () => {
    const resources = await fetchRemoteHtmlImages(
      '<img src="missing.png">',
      'https://example.com/article',
      async () => Promise.reject(new TypeError('Network failure')),
    );

    expect(resources).toEqual([]);
  });

  it('fetches only same-origin HTML stylesheets', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response('.ltx_authors { display: grid }', {
          headers: { 'content-type': 'text/css' },
        }),
      ),
    );

    const stylesheets = await fetchRemoteHtmlStylesheets(
      '<link rel="stylesheet" href="/static/article.css"><link rel="stylesheet" href="https://use.typekit.net/font.css">',
      'https://example.com/articles/document',
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/static/article.css',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(stylesheets).toEqual(['.ltx_authors { display: grid }']);
  });
});
