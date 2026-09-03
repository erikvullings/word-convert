import { describe, expect, it, vi } from 'vitest';

import {
  fetchRemoteDocument,
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
});
