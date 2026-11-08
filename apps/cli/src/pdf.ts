// @ts-expect-error PDF.js does not publish declarations for its worker entrypoint.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type {
  DocumentModel,
  ConversionOptions,
} from '@wordconvert/document-model';
import { loadNativeRuntime } from './native-runtime.ts';
import {
  automaticProvider,
  type ProviderSelection,
} from './inference-options.ts';

export interface CliPdfOptions extends ConversionOptions {
  layoutModel?: string;
  formulaModelDir?: string;
  rasterize?: boolean;
  runtimeDir?: string;
  executionProvider?: ProviderSelection;
  onDiagnostic?: (message: string) => void;
}

// PDF.js discovers this in-process worker instead of importing a file at runtime.
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

export async function readPdf(
  input: Uint8Array,
  filename: string,
  options: CliPdfOptions,
): Promise<DocumentModel> {
  const runtime =
    options.rasterize || options.layoutModel || options.formulaModelDir
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
    const { pdfJsReader } = await import('@wordconvert/pdf-reader');
    const { model } = await pdfJsReader.read(input, {
      conversionDate: options.conversionDate,
      filename,
      densePageMode: adapters ? 'image-and-prose' : 'extract',
      ...(adapters ? { figureRasterizer: adapters.figureRasterizer } : {}),
      ...(adapters?.layoutDetector
        ? { layoutDetector: adapters.layoutDetector }
        : {}),
      ...(adapters?.formulaRecognizer
        ? { formulaRecognizer: adapters.formulaRecognizer }
        : {}),
    });
    if (!adapters)
      model.warnings.push({
        code: 'cli-pdf-geometry-only',
        severity: 'warning',
        message:
          'PDF conversion uses geometry and embedded raster images only. Enable --rasterize, --layout-model, or --formula-model-dir for richer extraction.',
      });
    return model;
  } finally {
    await adapters?.dispose();
  }
}
