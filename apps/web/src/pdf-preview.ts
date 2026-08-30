import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfJsWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfJsWorkerSrc;

export interface PdfPagePreviewResult {
  pageNumber: number;
  width: number;
  height: number;
  blob: Blob;
}

export interface PdfPagePreviewRenderer {
  render(input: ArrayBuffer, pageNumber: number): Promise<PdfPagePreviewResult>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 2_000;
const MAX_WIDTH = 1_200;
const MAX_PIXELS = 4_000_000;

export function createPdfPagePreviewRenderer(): PdfPagePreviewRenderer {
  const loadingTasks = new Set<PDFDocumentLoadingTask>();
  const renderTasks = new Set<RenderTask>();

  const cancel = async (): Promise<void> => {
    for (const task of renderTasks) task.cancel();
    renderTasks.clear();
    const pending = [...loadingTasks];
    loadingTasks.clear();
    await Promise.all(pending.map((task) => task.destroy()));
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
    if (input.byteLength > MAX_INPUT_BYTES)
      throw new Error('PDF exceeds the input size limit.');
    const task = getDocument({
      data: new Uint8Array(input.slice(0)),
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      disableFontFace: false,
      isOffscreenCanvasSupported: false,
      useSystemFonts: true,
      useWasm: false,
      verbosity: 0,
    });
    loadingTasks.add(task);
    try {
      const document = await task.promise;
      if (document.numPages > MAX_PAGES)
        throw new Error('PDF exceeds the page limit.');
      return { task, document };
    } catch (cause) {
      if (loadingTasks.delete(task)) await task.destroy();
      throw cause;
    }
  };

  return {
    cancel,
    async dispose() {
      await dispose();
    },
    async render(input, pageNumber) {
      await cancel();
      const loaded = await load(input);
      try {
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
          const renderTask = page.render({
            canvas,
            viewport,
            background: '#ffffff',
          });
          renderTasks.add(renderTask);
          try {
            await renderTask.promise;
            return {
              pageNumber,
              width,
              height,
              blob: await canvasBlob(canvas),
            };
          } finally {
            renderTasks.delete(renderTask);
          }
        } finally {
          page.cleanup();
        }
      } finally {
        if (loadingTasks.delete(loaded.task)) await loaded.task.destroy();
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
