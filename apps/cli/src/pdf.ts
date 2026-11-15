// @ts-expect-error PDF.js does not publish declarations for its worker entrypoint.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  DocumentModel,
  ConversionOptions,
} from '@wordconvert/document-model';
import { loadNativeRuntime } from './native-runtime.ts';
import {
  automaticProvider,
  type ProviderSelection,
} from './inference-options.ts';
import type {
  PdfFigureRasterizer,
  PdfReaderOptions,
  PdfTableOptions,
} from '@wordconvert/pdf-reader';

export interface CliPdfOptions extends ConversionOptions {
  layoutModel?: string;
  formulaModelDir?: string;
  rasterize?: boolean;
  frontPageCover?: boolean;
  pdfTables?: PdfTableOptions;
  unwrapFactor?: number;
  dehyphenate?: boolean;
  runtimeDir?: string;
  executionProvider?: ProviderSelection;
  onDiagnostic?: (message: string) => void;
}

export interface CliPdfResult {
  model: DocumentModel;
  coverPng?: Uint8Array;
}

// PDF.js discovers this in-process worker instead of importing a file at runtime.
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

export async function readPdf(
  input: Uint8Array,
  filename: string,
  options: CliPdfOptions,
): Promise<CliPdfResult> {
  const runtime =
    options.rasterize ||
    options.layoutModel ||
    options.formulaModelDir ||
    options.frontPageCover
      ? loadNativeRuntime(options.runtimeDir)
      : undefined;
  let adapters:
    | Awaited<
        ReturnType<
          (typeof import('./native-pdf.ts'))['createNativePdfAdapters']
        >
      >
    | undefined;
  if (runtime) {
    const { createNativePdfAdapters } = await import('./native-pdf.ts');
    const selection = options.executionProvider ?? 'cpu';
    const provider =
      selection === 'auto'
        ? automaticProvider(runtime.ort.listSupportedBackends())
        : selection;
    if (options.layoutModel || options.formulaModelDir)
      options.onDiagnostic?.(
        `Inference provider: ${provider}${selection === 'auto' ? ' (automatic)' : ''}.\n`,
      );
    if (
      selection === 'auto' &&
      provider === 'cpu' &&
      (options.layoutModel || options.formulaModelDir)
    )
      options.onDiagnostic?.(
        'warning: No GPU provider is bundled on this platform; using CPU.\n',
      );
    try {
      adapters = await createNativePdfAdapters(runtime, {
        ...options,
        executionProvider: provider,
      });
    } catch (error) {
      if (selection !== 'auto' || provider === 'cpu') throw error;
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message)
          : String(error);
      options.onDiagnostic?.(
        `warning: ${provider} initialization failed: ${message} Retrying on CPU; use --execution-provider ${provider} to require GPU success.\n`,
      );
      adapters = await createNativePdfAdapters(runtime, {
        ...options,
        executionProvider: 'cpu',
      });
    }
  }
  try {
    const { analysePdf, pdfJsReader } = await import('@wordconvert/pdf-reader');
    const readerOptions: PdfReaderOptions = {
      conversionDate: options.conversionDate,
      filename,
      densePageMode:
        options.rasterize || options.layoutModel || options.formulaModelDir
          ? 'image-and-prose'
          : 'extract',
      ...(options.pdfTables ? { pdfTables: options.pdfTables } : {}),
      ...(options.unwrapFactor !== undefined
        ? { unwrapFactor: options.unwrapFactor }
        : {}),
      ...(options.dehyphenate !== undefined
        ? { dehyphenate: options.dehyphenate }
        : {}),
      ...(adapters ? { figureRasterizer: adapters.figureRasterizer } : {}),
      ...(adapters?.layoutDetector
        ? { layoutDetector: adapters.layoutDetector }
        : {}),
      ...(adapters?.formulaRecognizer
        ? { formulaRecognizer: adapters.formulaRecognizer }
        : {}),
    };
    const coverPng =
      options.frontPageCover && runtime && adapters
        ? await renderFrontPageCover(
            input,
            runtime.canvas,
            adapters.figureRasterizer,
          )
        : undefined;
    const raw = await pdfJsReader.readRaw(input, readerOptions);
    if (options.frontPageCover && raw.pages[0])
      raw.pages[0] = { ...raw.pages[0], images: [] };
    const { model } = await analysePdf(raw, {
      conversionDate: options.conversionDate,
      filename,
      ...(options.pdfTables ? { pdfTables: options.pdfTables } : {}),
      ...(options.unwrapFactor !== undefined
        ? { unwrapFactor: options.unwrapFactor }
        : {}),
      ...(options.dehyphenate !== undefined
        ? { dehyphenate: options.dehyphenate }
        : {}),
    });
    if (!options.rasterize && !options.layoutModel && !options.formulaModelDir)
      model.warnings.push({
        code: 'cli-pdf-geometry-only',
        severity: 'warning',
        message:
          'PDF conversion uses geometry and embedded raster images only. Enable --rasterize, --layout-model, or --formula-model-dir for richer extraction.',
      });
    return { model, ...(coverPng ? { coverPng } : {}) };
  } finally {
    await adapters?.dispose();
  }
}

async function renderFrontPageCover(
  input: Uint8Array,
  canvasModule: ReturnType<typeof loadNativeRuntime>['canvas'],
  rasterizer: PdfFigureRasterizer,
): Promise<Uint8Array> {
  const loading = getDocument({
    data: input.slice(),
    CanvasFactory: rasterizer.CanvasFactory,
    FilterFactory: rasterizer.FilterFactory,
    useWasm: false,
  });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    try {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: 1600 / Math.max(base.width, base.height),
      });
      const canvas = canvasModule.createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas: canvas as never,
        viewport,
        background: '#ffffff',
      }).promise;
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally {
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
}
