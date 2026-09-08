// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { destroy, getDocument, globalWorkerOptions } = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  getDocument: vi.fn(),
  globalWorkerOptions: {} as { workerSrc?: string },
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument,
  GlobalWorkerOptions: globalWorkerOptions,
}));

import { createPdfPagePreviewRenderer } from './pdf-preview.ts';

describe('PDF page preview renderer', () => {
  beforeEach(() => {
    destroy.mockClear();
    getDocument.mockReset();
  });

  it('loads bundled image decoders for scanned PDF pages', async () => {
    getDocument.mockReturnValue({
      destroy,
      promise: Promise.reject(new Error('Stop after inspecting options.')),
    });
    const renderer = createPdfPagePreviewRenderer();

    await expect(renderer.render(new ArrayBuffer(8), 1)).rejects.toThrow(
      'Stop after inspecting options.',
    );

    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        useWasm: true,
        wasmUrl: 'http://localhost:3000/pdfjs/',
      }),
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('loads the PDF worker from the stable application asset path', () => {
    expect(globalWorkerOptions.workerSrc).toBe(
      'http://localhost:3000/pdfjs/pdf.worker.mjs',
    );
  });
});
