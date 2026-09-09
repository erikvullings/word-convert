// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

const { destroy, getDocument, globalWorkerOptions } = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  getDocument: vi.fn(),
  globalWorkerOptions: {} as { workerSrc?: string },
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument,
  GlobalWorkerOptions: globalWorkerOptions,
}));

import {
  createPdfPagePreviewRenderer,
  normalizedCropPixels,
} from './pdf-preview.ts';

describe('PDF page preview renderer', () => {
  beforeEach(() => {
    destroy.mockClear();
    getDocument.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('clamps normalized crop bounds to rendered page pixels', () => {
    expect(
      normalizedCropPixels(
        { x: 0.25, top: 0.1, width: 0.5, height: 0.4 },
        1_200,
        1_600,
      ),
    ).toEqual({ x: 300, y: 160, width: 600, height: 640 });
    expect(
      normalizedCropPixels(
        { x: -0.1, top: 0.9, width: 1.5, height: 0.5 },
        1_200,
        1_600,
      ),
    ).toEqual({ x: 0, y: 1440, width: 1_200, height: 160 });
  });

  it('reuses one loaded PDF document across page renders', async () => {
    const destroyLoadedDocument = vi.fn(async () => undefined);
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
    const loadDocument = vi.fn(
      () =>
        ({
          destroy: destroyLoadedDocument,
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
    const renderer = createPdfPagePreviewRenderer(loadDocument);
    const input = new ArrayBuffer(16);

    expect((await renderer.render(input, 41)).pageNumber).toBe(41);
    expect((await renderer.render(input, 158)).pageNumber).toBe(158);

    expect(loadDocument).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroyLoadedDocument).not.toHaveBeenCalled();

    await renderer.dispose();
    expect(destroyLoadedDocument).toHaveBeenCalledOnce();
  });
});
