import {
  isConversionError,
  type CancellationSignal,
  type ConversionError,
} from '@wordconvert/document-model';
import { DocxReadError, secureDocxReader } from '@wordconvert/docx-reader';
import { writeHtml, writeHtmlZip } from '@wordconvert/html-writer';
import { writeMarkdown, writeMarkdownZip } from '@wordconvert/markdown-writer';
import { writeEpub } from '@wordconvert/epub-writer';
import {
  configurePdfJsWorker,
  PDF_DENSE_PAGE_MODES,
  PdfReadError,
  pdfJsReader,
  type PdfDensePageMode,
} from '@wordconvert/pdf-reader';
import { unzipSync } from 'fflate';

import type { WorkerRequest, WorkerSend } from './protocol.ts';
import { createConfiguredFormulaRecognizer } from 'virtual:wordconvert-formula-recognizer';
import { createPdfFigureRasterizer } from './pdf-figure-rasterizer.ts';
import { pdfJsWorkerUrl } from '../pdfjs-assets.ts';

if (typeof Worker !== 'undefined')
  configurePdfJsWorker(
    pdfJsWorkerUrl(__WORDCONVERT_BASE_PATH__, globalThis.location.origin),
  );

export interface WorkerRuntime {
  handle(request: WorkerRequest): Promise<void>;
  activeOperationCount(): number;
}

export function createWorkerRuntime(send: WorkerSend): WorkerRuntime {
  const operations = new Map<string, CancellationSignal>();
  const densePageAnswers = new Map<
    string,
    { resolve(mode: PdfDensePageMode): void; reject(cause: unknown): void }
  >();
  let layoutDetector:
    | Promise<
        import('./heron-layout-detector.ts').HeronLayoutDetector | undefined
      >
    | undefined;
  const formulaRecognizer = createConfiguredFormulaRecognizer();

  return {
    activeOperationCount: () => operations.size,
    async handle(request) {
      if (request.type === 'cancel') {
        const signal = operations.get(request.operationId);
        if (signal) signal.cancelled = true;
        densePageAnswers.get(request.operationId)?.reject(cancelledError());
        return;
      }
      if (request.type === 'pdf-dense-page-answer') {
        if (PDF_DENSE_PAGE_MODES.includes(request.mode))
          densePageAnswers.get(request.operationId)?.resolve(request.mode);
        return;
      }

      const signal = operations.get(request.operationId) ?? {
        cancelled: false,
      };
      operations.set(request.operationId, signal);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (signal.cancelled) throw cancelledError();
        if (request.type === 'prepare-pdf-layout') {
          send({
            type: 'pdf-layout-status',
            operationId: request.operationId,
            status: 'loading',
          });
          const detector = await (layoutDetector ??= loadHeronLayoutDetector());
          const ready = detector ? await detector.prepare() : false;
          if (signal.cancelled) throw cancelledError();
          send({
            type: 'pdf-layout-status',
            operationId: request.operationId,
            status: ready ? 'ready' : 'unavailable',
          });
        } else if (request.type === 'analyse') {
          const readerOptions = {
            filename: request.filename,
            conversionDate: request.conversionDate,
            ...(request.styleMappings
              ? { styleMappings: request.styleMappings }
              : {}),
            cancellation: signal,
            onProgress: (
              progress: import('@wordconvert/document-model').ConversionProgress,
            ) =>
              send({
                type: 'progress',
                operationId: request.operationId,
                progress,
              }),
          };
          const figureRasterizer =
            request.sourceFormat === 'pdf' &&
            request.pdfOptions?.samplePageCount === undefined
              ? createPdfFigureRasterizer()
              : undefined;
          const detector =
            figureRasterizer &&
            request.pdfOptions?.layoutDetectionEnabled !== false
              ? await (layoutDetector ??= loadHeronLayoutDetector())
              : undefined;
          if (signal.cancelled) throw cancelledError();
          const { askDensePageMode, ...pdfOptions } = request.pdfOptions ?? {};
          const resolveDensePageMode =
            askDensePageMode && !pdfOptions.densePageMode
              ? (dense: { page: number; vectorPaths: number }) =>
                  new Promise<PdfDensePageMode>((resolve, reject) => {
                    if (signal.cancelled) {
                      reject(cancelledError());
                      return;
                    }
                    densePageAnswers.set(request.operationId, {
                      resolve,
                      reject,
                    });
                    send({
                      type: 'pdf-dense-page-question',
                      operationId: request.operationId,
                      ...dense,
                    });
                  }).finally(() => densePageAnswers.delete(request.operationId))
              : undefined;
          const pdfResult =
            request.sourceFormat === 'pdf'
              ? await pdfJsReader.read(new Uint8Array(request.input), {
                  ...readerOptions,
                  ...pdfOptions,
                  ...(resolveDensePageMode ? { resolveDensePageMode } : {}),
                  ...(figureRasterizer ? { figureRasterizer } : {}),
                  ...(detector ? { layoutDetector: detector } : {}),
                  ...(figureRasterizer &&
                  request.pdfOptions?.formulaRecognitionEnabled !== false
                    ? { formulaRecognizer }
                    : {}),
                })
              : undefined;
          const model =
            pdfResult?.model ??
            (await secureDocxReader.read(
              new Uint8Array(request.input),
              readerOptions,
            ));
          if (signal.cancelled) throw cancelledError();
          send({
            type: 'analysed',
            operationId: request.operationId,
            model,
            ...(pdfResult ? { pdfAnalysis: pdfResult.analysis } : {}),
          });
        } else {
          send({
            type: 'progress',
            operationId: request.operationId,
            progress: { phase: 'write', completed: 0, total: 1 },
          });
          const warnings = [...request.model.warnings];
          const written =
            request.format === 'epub'
              ? await writeEpub(request.model, {
                  conversionDate: request.conversionDate,
                  formulaMode: request.formulaMode ?? 'mathml',
                  ...(request.cover ? { cover: request.cover } : {}),
                  ...(request.coverPng ? { coverPng: request.coverPng } : {}),
                  ...(request.sourceHtml
                    ? {
                        sourceXhtml: request.sourceHtml.xhtml,
                        sourceCss: request.sourceHtml.css,
                      }
                    : {}),
                })
              : request.format === 'html' && request.mode === 'zip'
                ? await writeHtmlZip(request.model, {
                    conversionDate: request.conversionDate,
                    formulaMode: request.formulaMode ?? 'mathml',
                    ...(request.sourceHtml
                      ? {
                          sourceHtml: request.sourceHtml.html,
                          sourceCss: request.sourceHtml.css,
                        }
                      : {}),
                  })
                : request.format === 'markdown' && request.mode === 'zip'
                  ? await writeMarkdownZip(request.model, {
                      conversionDate: request.conversionDate,
                      formulaMode: request.formulaMode ?? 'mathml',
                      includeInternalLinks:
                        request.includeInternalLinks ?? true,
                      onWarning: (warning) => warnings.push(warning),
                    })
                  : new TextEncoder().encode(
                      request.format === 'html'
                        ? writeHtml(request.model, {
                            conversionDate: request.conversionDate,
                            formulaMode: request.formulaMode ?? 'mathml',
                            ...(request.sourceHtml
                              ? {
                                  sourceHtml: request.sourceHtml.html,
                                  sourceCss: request.sourceHtml.css,
                                }
                              : {}),
                          })
                        : writeMarkdown(request.model, {
                            conversionDate: request.conversionDate,
                            formulaMode: request.formulaMode ?? 'mathml',
                            includeInternalLinks:
                              request.includeInternalLinks ?? true,
                            onWarning: (warning) => warnings.push(warning),
                          }),
                    );
          if (signal.cancelled) throw cancelledError();
          const data = Uint8Array.from(written).buffer;
          send(
            {
              type: 'output',
              operationId: request.operationId,
              filename: outputFilename(
                request.filename,
                request.format,
                request.mode,
              ),
              mediaType:
                request.mode === 'zip'
                  ? 'application/zip'
                  : request.format === 'html'
                    ? 'text/html;charset=utf-8'
                    : request.format === 'markdown'
                      ? 'text/markdown;charset=utf-8'
                      : 'application/epub+zip',
              data,
              warnings,
              ...(request.format === 'epub'
                ? { files: Object.keys(unzipSync(written)).sort() }
                : {}),
            },
            [data],
          );
          await formulaRecognizer.dispose?.();
        }
      } catch (cause) {
        send({
          type: 'error',
          operationId: request.operationId,
          error: normaliseError(cause),
        });
      } finally {
        operations.delete(request.operationId);
        densePageAnswers.delete(request.operationId);
      }
    },
  };
}

async function loadHeronLayoutDetector() {
  try {
    const [{ default: modelUrl }, { createHeronLayoutDetector }] =
      await Promise.all([
        import('../assets/heron/model_fp16.onnx?url'),
        import('./heron-layout-detector.ts'),
      ]);
    return createHeronLayoutDetector(modelUrl);
  } catch {
    return undefined;
  }
}

function outputFilename(
  sourceFilename: string,
  format: 'html' | 'markdown' | 'epub',
  mode?: import('../output.ts').ConversionMode,
): string {
  const extension =
    mode === 'zip'
      ? `-${format}.zip`
      : format === 'html'
        ? '.html'
        : format === 'markdown'
          ? '.md'
          : '.epub';
  const baseName = sourceFilename.split(/[\\/]/).at(-1)?.trim() ?? '';
  const stem = baseName.replace(/\.[^./\\]+$/, '').trim();
  return `${stem || 'document'}${extension}`;
}

function cancelledError(): ConversionError {
  return {
    code: 'cancelled',
    message: 'The operation was cancelled.',
    recoverable: true,
  };
}

function normaliseError(cause: unknown): ConversionError {
  if (
    cause instanceof DocxReadError ||
    cause instanceof PdfReadError ||
    isConversionError(cause)
  ) {
    return {
      code: cause.code,
      message: cause.message,
      recoverable: cause.recoverable,
      ...(cause.phase ? { phase: cause.phase } : {}),
      ...(cause.details ? { details: cause.details } : {}),
    };
  }
  return {
    code: 'conversion-failed',
    message: 'The document could not be processed.',
    recoverable: true,
  };
}
