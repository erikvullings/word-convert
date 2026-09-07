import { describe, expect, it, vi } from 'vitest';

import {
  canShareEpub,
  createEpubFile,
  deliverDownload,
  openEpubEmail,
  saveDownload,
  shareEpub,
} from './index.ts';

describe('EPUB sharing', () => {
  it.each([
    ['book', 'book.epub'],
    ['book.epub', 'book.epub'],
    ['BOOK.EPUB', 'BOOK.EPUB'],
  ])('creates an EPUB file named %s as %s', (filename, expected) => {
    const file = createEpubFile(new Blob(['book']), filename);

    expect(file.name).toBe(expected);
    expect(file.type).toBe('application/epub+zip');
  });

  it('requires both share APIs and an accepted EPUB file', () => {
    const file = createEpubFile(new Blob(['book']), 'book.epub');

    expect(canShareEpub(file, {})).toBe(false);
    expect(canShareEpub(file, { canShare: () => true })).toBe(false);
    expect(
      canShareEpub(file, {
        canShare: () => false,
        share: async () => undefined,
      }),
    ).toBe(false);
    expect(
      canShareEpub(file, {
        canShare: () => {
          throw new DOMException('Unsupported', 'NotSupportedError');
        },
        share: async () => undefined,
      }),
    ).toBe(false);
    expect(
      canShareEpub(file, {
        canShare: ({ files }) => files?.[0] === file,
        share: async () => undefined,
      }),
    ).toBe(true);
  });

  it('returns shared after handing the EPUB to the native share API', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(
      async () => undefined,
    );

    const result = await shareEpub(
      {
        blob: new Blob(['book']),
        filename: 'attention',
        title: 'Attention Is All You Need',
        text: 'EPUB: Attention Is All You Need',
      },
      { canShare: () => true, share },
    );

    expect(result).toEqual({ status: 'shared' });
    expect(share).toHaveBeenCalledWith({
      title: 'Attention Is All You Need',
      text: 'EPUB: Attention Is All You Need',
      files: [
        expect.objectContaining({
          name: 'attention.epub',
          type: 'application/epub+zip',
        }),
      ],
    });
  });

  it('returns unsupported when the EPUB file cannot be shared', async () => {
    const result = await shareEpub(
      { blob: new Blob(['book']), filename: 'book.epub' },
      { canShare: () => false, share: async () => undefined },
    );

    expect(result).toEqual({ status: 'unsupported' });
  });

  it('returns cancelled when the native share sheet is closed', async () => {
    const result = await shareEpub(
      { blob: new Blob(['book']), filename: 'book.epub' },
      {
        canShare: () => true,
        share: async () => {
          throw new DOMException('Cancelled', 'AbortError');
        },
      },
    );

    expect(result).toEqual({ status: 'cancelled' });
  });

  it('returns unexpected native share failures without changing transport', async () => {
    const error = new DOMException('Sharing unavailable', 'NotAllowedError');

    const result = await shareEpub(
      { blob: new Blob(['book']), filename: 'book.epub' },
      {
        canShare: () => true,
        share: async () => {
          throw error;
        },
      },
    );

    expect(result).toEqual({ status: 'failed', error });
  });

  it('opens an email draft that asks the user to attach the downloaded EPUB', () => {
    const openMailto = vi.fn();

    openEpubEmail(
      {
        title: 'Attention & Transformers',
        filename: 'attention.epub',
      },
      { openMailto },
    );

    const url = openMailto.mock.calls[0]?.[0] ?? '';
    expect(url).toContain('subject=EPUB%3A%20Attention%20%26%20Transformers');
    expect(decodeURIComponent(url)).toContain(
      'Please attach the downloaded file "attention.epub" to this message.',
    );
    expect(url).not.toContain('attachment=');
    expect(url).not.toContain('data%3A');
  });
});

describe('download lifecycle', () => {
  it('revokes the object URL and releases the output after starting the download', () => {
    const click = vi.fn();
    const revoke = vi.fn();
    const release = vi.fn();
    deliverDownload(
      {
        filename: 'report.html',
        mediaType: 'text/html',
        data: new ArrayBuffer(4),
      },
      {
        createObjectURL: () => 'blob:local-only',
        revokeObjectURL: revoke,
        createAnchor: () => ({ href: '', download: '', click }),
      },
      release,
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:local-only');
    expect(release).toHaveBeenCalledOnce();
  });

  it('opens a native save picker with the generated filename and writes locally', async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({ write, close }),
    }));
    const release = vi.fn();

    await saveDownload(
      {
        filename: 'report.epub',
        mediaType: 'application/epub+zip',
        data: new ArrayBuffer(4),
      },
      {
        showSaveFilePicker,
        createObjectURL: () => 'unused',
        revokeObjectURL: () => undefined,
        createAnchor: () => ({
          href: '',
          download: '',
          click: () => undefined,
        }),
      },
      release,
    );

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'report.epub',
      types: [
        {
          description: 'EPUB file',
          accept: { 'application/epub+zip': ['.epub'] },
        },
      ],
    });
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains the output when the native save picker is cancelled', async () => {
    const release = vi.fn();
    const saved = await saveDownload(
      {
        filename: 'report.epub',
        mediaType: 'application/epub+zip',
        data: new ArrayBuffer(4),
      },
      {
        showSaveFilePicker: async () => {
          throw new DOMException('Cancelled', 'AbortError');
        },
        createObjectURL: () => 'unused',
        revokeObjectURL: () => undefined,
        createAnchor: () => ({
          href: '',
          download: '',
          click: () => undefined,
        }),
      },
      release,
    );

    expect(saved).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it('falls back to a browser download when the native save picker fails', async () => {
    const click = vi.fn();
    const revoke = vi.fn();
    const release = vi.fn();

    const saved = await saveDownload(
      {
        filename: 'report.epub',
        mediaType: 'application/epub+zip',
        data: new ArrayBuffer(4),
      },
      {
        showSaveFilePicker: async () => {
          throw new DOMException('Picker unavailable', 'NotAllowedError');
        },
        createObjectURL: () => 'blob:local-only',
        revokeObjectURL: revoke,
        createAnchor: () => ({ href: '', download: '', click }),
      },
      release,
    );

    expect(saved).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:local-only');
    expect(release).toHaveBeenCalledOnce();
  });
});
