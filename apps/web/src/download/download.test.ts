import { describe, expect, it, vi } from 'vitest';

import { deliverDownload, saveDownload } from './index.ts';

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
});
