import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfBounds } from '@wordconvert/pdf-reader';

import { pdfJsDecoderBaseUrl, pdfJsWorkerUrl } from './pdfjs-assets.ts';

GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl(
  __WORDCONVERT_BASE_PATH__,
  globalThis.location.origin,
);

export interface PdfPagePreviewResult {
  pageNumber: number;
  width: number;
  height: number;
  blob: Blob;
}

export interface PdfPagePreviewRenderer {
  render(
    input: ArrayBuffer,
    pageNumber: number,
    crop?: PdfBounds,
  ): Promise<PdfPagePreviewResult>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 2_000;
const MAX_WIDTH = 1_200;
const MAX_PIXELS = 4_000_000;

export function normalizedCropPixels(
  bounds: PdfBounds,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const left = Math.max(0, Math.min(1, bounds.x));
  const top = Math.max(0, Math.min(1, bounds.top));
  const right = Math.max(left, Math.min(1, bounds.x + bounds.width));
  const bottom = Math.max(top, Math.min(1, bounds.top + bounds.height));
  const x = Math.round(left * width);
  const y = Math.round(top * height);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right * width) - x),
    height: Math.max(1, Math.round(bottom * height) - y),
  };
}

export function createPdfPagePreviewRenderer(
  loadDocument: typeof getDocument = getDocument,
): PdfPagePreviewRenderer {
  let loadedInput: ArrayBuffer | undefined;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let loadedDocument: PDFDocumentProxy | undefined;
  let renderTask: RenderTask | undefined;

  const cancel = async (): Promise<void> => {
    renderTask?.cancel();
    renderTask = undefined;
    const task = loadingTask;
    loadingTask = undefined;
    loadedDocument = undefined;
    loadedInput = undefined;
    if (task)
      try {
        await task.destroy();
      } catch {
        // PDF.js cleanup is best-effort; a failed destroy must not poison reuse.
      }
  };
  const dispose = async (): Promise<void> => {
    await cancel();
  };

  const load = async (
    input: ArrayBuffer,
  ): Promise<{
    task: PDFDocumentLoadingTask;
    document: PDFDocumentProxy;
  }> => {
    if (loadedInput === input && loadingTask && loadedDocument)
      return { task: loadingTask, document: loadedDocument };
    await cancel();
    if (input.byteLength > MAX_INPUT_BYTES)
      throw new Error('PDF exceeds the input size limit.');
    const task = loadDocument({
      data: new Uint8Array(input.slice(0)),
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      disableFontFace: false,
      isOffscreenCanvasSupported: false,
      useSystemFonts: true,
      useWasm: true,
      wasmUrl: pdfJsDecoderBaseUrl(
        __WORDCONVERT_BASE_PATH__,
        globalThis.location.origin,
      ),
      verbosity: 0,
    });
    loadingTask = task;
    loadedInput = input;
    try {
      const document = await task.promise;
      if (document.numPages > MAX_PAGES)
        throw new Error('PDF exceeds the page limit.');
      loadedDocument = document;
      return { task, document };
    } catch (cause) {
      if (loadingTask === task) {
        loadingTask = undefined;
        loadedInput = undefined;
      }
      try {
        await task.destroy();
      } catch {
        // Preserve the load failure rather than replacing it with cleanup failure.
      }
      throw cause;
    }
  };

  return {
    cancel,
    async dispose() {
      await dispose();
    },
    async render(input, pageNumber, crop) {
      const loaded = await load(input);
      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > loaded.document.numPages
      )
        throw new Error('The requested PDF preview page does not exist.');
      const page = await loaded.document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(
          MAX_WIDTH / base.width,
          Math.sqrt(MAX_PIXELS / (base.width * base.height)),
        );
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const canvas = documentOwner().createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const currentRenderTask = page.render({
          canvas,
          viewport,
          background: '#ffffff',
        });
        renderTask = currentRenderTask;
        try {
          await currentRenderTask.promise;
          let outputCanvas = canvas;
          if (crop) {
            const pixels = normalizedCropPixels(crop, width, height);
            outputCanvas = documentOwner().createElement('canvas');
            outputCanvas.width = pixels.width;
            outputCanvas.height = pixels.height;
            const context = outputCanvas.getContext('2d');
            if (!context)
              throw new Error('The PDF image crop could not be created.');
            context.drawImage(
              canvas,
              pixels.x,
              pixels.y,
              pixels.width,
              pixels.height,
              0,
              0,
              pixels.width,
              pixels.height,
            );
          }
          return {
            pageNumber,
            width: outputCanvas.width,
            height: outputCanvas.height,
            blob: await canvasBlob(outputCanvas),
          };
        } finally {
          if (renderTask === currentRenderTask) renderTask = undefined;
        }
      } finally {
        page.cleanup();
      }
    },
  };
}

function documentOwner(): Document {
  if (typeof document === 'undefined')
    throw new Error('PDF page preview requires a browser canvas.');
  return document;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The PDF page preview could not be encoded.'));
    }, 'image/png');
  });
}
