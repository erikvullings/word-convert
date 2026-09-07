import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { createPdfPagePreviewRenderer } from './pdf-preview.ts';

describe('PDF page preview renderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses one loaded PDF document across page renders', async () => {
    const destroy = vi.fn(async () => undefined);
    const cleanup = vi.fn();
    const getPage = vi.fn(async () => ({
      cleanup,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => ({
        cancel: vi.fn(),
        promise: Promise.resolve(),
      }),
    }));
    const getDocument = vi.fn(
      () =>
        ({
          destroy,
          promise: Promise.resolve({ numPages: 160, getPage }),
        }) as unknown as PDFDocumentLoadingTask,
    );
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob(['preview'], { type: 'image/png' })),
      }),
    });
    const renderer = createPdfPagePreviewRenderer(getDocument);
    const input = new ArrayBuffer(16);

    expect((await renderer.render(input, 41)).pageNumber).toBe(41);
    expect((await renderer.render(input, 158)).pageNumber).toBe(158);

    expect(getDocument).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();

    await renderer.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
