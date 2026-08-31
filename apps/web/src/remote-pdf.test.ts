import { describe, expect, it, vi } from 'vitest';

import { fetchRemotePdf, normalizePdfUrl } from './remote-pdf.ts';

describe('remote PDF loading', () => {
  it('converts arXiv abstract URLs to direct PDF URLs', () => {
    expect(normalizePdfUrl('https://arxiv.org/abs/1706.03762')).toBe(
      'https://arxiv.org/pdf/1706.03762',
    );
    expect(normalizePdfUrl('https://www.arxiv.org/abs/1706.03762v7')).toBe(
      'https://arxiv.org/pdf/1706.03762v7',
    );
  });

  it('rejects non-HTTPS and credential-bearing URLs', () => {
    expect(() => normalizePdfUrl('http://example.com/paper.pdf')).toThrow(
      'HTTPS',
    );
    expect(() =>
      normalizePdfUrl('https://user:secret@example.com/a.pdf'),
    ).toThrow('credentials');
  });

  it('downloads a bounded PDF and derives its filename', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nfixture');
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(bytes, {
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(bytes.byteLength),
            'content-disposition': 'inline; filename="paper-v7.pdf"',
          },
        }),
      ),
    );

    const file = await fetchRemotePdf(
      'https://arxiv.org/abs/1706.03762',
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://arxiv.org/pdf/1706.03762',
      expect.objectContaining({
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(file.name).toBe('paper-v7.pdf');
    expect(file.type).toBe('application/pdf');
  });

  it('explains browser-access failures', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      fetchRemotePdf('https://example.com/paper.pdf', fetcher),
    ).rejects.toThrow('does not allow browser access');
  });

  it('rejects oversized and non-PDF responses before analysis', async () => {
    const oversized = new Response('%PDF-', {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(51 * 1024 * 1024),
      },
    });
    await expect(
      fetchRemotePdf('https://example.com/large.pdf', async () => oversized),
    ).rejects.toThrow('50 MiB');

    const html = new Response('<html>Not a PDF</html>', {
      headers: { 'content-type': 'text/html' },
    });
    await expect(
      fetchRemotePdf('https://example.com/paper', async () => html),
    ).rejects.toThrow('did not return a PDF');
  });
});
