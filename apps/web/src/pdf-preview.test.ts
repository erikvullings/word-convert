// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { destroy, getDocument } = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument,
  GlobalWorkerOptions: {},
}));

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: '/assets/pdf.worker.mjs',
}));

import { createPdfPagePreviewRenderer } from './pdf-preview.ts';

describe('PDF page preview renderer', () => {
  beforeEach(() => {
    destroy.mockClear();
    getDocument.mockReset();
    getDocument.mockReturnValue({
      destroy,
      promise: Promise.reject(new Error('Stop after inspecting options.')),
    });
  });

  it('loads bundled image decoders for scanned PDF pages', async () => {
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
});
