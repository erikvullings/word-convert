import { describe, expect, it, vi } from 'vitest';

import { deliverDownload, mailEpub, saveDownload } from './index.ts';

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

  it('shares an EPUB file with the document title for mail clients', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(
      async () => undefined,
    );
    const openMailto = vi.fn();

    await mailEpub(
      {
        filename: 'attention.epub',
        mediaType: 'application/epub+zip',
        data: new Uint8Array([1, 2, 3]).buffer,
      },
      'Attention Is All You Need [1706.03762]',
      {
        canShare: ({ files }) => files?.[0]?.name === 'attention.epub',
        share,
        openMailto,
      },
    );

    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0]?.[0]).toMatchObject({
      title: 'Attention Is All You Need [1706.03762]',
      files: [
        expect.objectContaining({
          name: 'attention.epub',
          type: 'application/epub+zip',
        }),
      ],
    });
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('falls back to an empty mailto draft when file sharing is unavailable', async () => {
    const openMailto = vi.fn();

    await mailEpub(
      {
        filename: 'attention.epub',
        mediaType: 'application/epub+zip',
        data: new ArrayBuffer(1),
      },
      'Attention & Transformers',
      { openMailto },
    );

    expect(openMailto).toHaveBeenCalledWith(
      'mailto:?subject=Attention%20%26%20Transformers',
    );
  });

  it('reports a native file sharing failure without attempting a blocked fallback', async () => {
    const openMailto = vi.fn();

    await expect(
      mailEpub(
        {
          filename: 'attention.epub',
          mediaType: 'application/epub+zip',
          data: new ArrayBuffer(1),
        },
        'Attention & Transformers',
        {
          canShare: () => true,
          share: async () => {
            throw new DOMException('Sharing unavailable', 'NotAllowedError');
          },
          openMailto,
        },
      ),
    ).rejects.toMatchObject({ name: 'NotAllowedError' });

    expect(openMailto).not.toHaveBeenCalled();
  });

  it('does not open a mail draft when native sharing is cancelled', async () => {
    const openMailto = vi.fn();

    await expect(
      mailEpub(
        {
          filename: 'attention.epub',
          mediaType: 'application/epub+zip',
          data: new ArrayBuffer(1),
        },
        'Attention',
        {
          canShare: () => true,
          share: async () => {
            throw new DOMException('Cancelled', 'AbortError');
          },
          openMailto,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(openMailto).not.toHaveBeenCalled();
  });
});
