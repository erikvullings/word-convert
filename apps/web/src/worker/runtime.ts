import {
  isConversionError,
  type CancellationSignal,
  type ConversionError,
} from '@wordconvert/document-model';
import { secureDocxReader } from '@wordconvert/docx-reader';
import { writeHtml } from '@wordconvert/html-writer';
import { writeMarkdown } from '@wordconvert/markdown-writer';

import type { WorkerRequest, WorkerSend } from './protocol.ts';

export interface WorkerRuntime {
  handle(request: WorkerRequest): Promise<void>;
  activeOperationCount(): number;
}

export function createWorkerRuntime(send: WorkerSend): WorkerRuntime {
  const operations = new Map<string, CancellationSignal>();

  return {
    activeOperationCount: () => operations.size,
    async handle(request) {
      if (request.type === 'cancel') {
        const signal = operations.get(request.operationId) ?? {
          cancelled: false,
        };
        signal.cancelled = true;
        operations.set(request.operationId, signal);
        return;
      }

      const signal = operations.get(request.operationId) ?? {
        cancelled: false,
      };
      operations.set(request.operationId, signal);
      try {
        if (signal.cancelled) throw cancelledError();
        if (request.type === 'analyse') {
          const model = await secureDocxReader.read(
            new Uint8Array(request.input),
            {
              filename: request.filename,
              conversionDate: request.conversionDate,
              cancellation: signal,
              onProgress: (progress) =>
                send({
                  type: 'progress',
                  operationId: request.operationId,
                  progress,
                }),
            },
          );
          if (signal.cancelled) throw cancelledError();
          send({ type: 'analysed', operationId: request.operationId, model });
        } else {
          send({
            type: 'progress',
            operationId: request.operationId,
            progress: { phase: 'write', completed: 0, total: 1 },
          });
          const text =
            request.format === 'html'
              ? writeHtml(request.model, {
                  conversionDate: request.conversionDate,
                })
              : writeMarkdown(request.model, {
                  conversionDate: request.conversionDate,
                });
          if (signal.cancelled) throw cancelledError();
          const bytes = new TextEncoder().encode(text);
          const data = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
          send(
            {
              type: 'output',
              operationId: request.operationId,
              filename:
                request.format === 'html' ? 'document.html' : 'document.md',
              mediaType:
                request.format === 'html'
                  ? 'text/html;charset=utf-8'
                  : 'text/markdown;charset=utf-8',
              data,
            },
            [data],
          );
        }
      } catch (cause) {
        send({
          type: 'error',
          operationId: request.operationId,
          error: normaliseError(cause),
        });
      } finally {
        operations.delete(request.operationId);
      }
    },
  };
}

function cancelledError(): ConversionError {
  return {
    code: 'cancelled',
    message: 'The operation was cancelled.',
    recoverable: true,
  };
}

function normaliseError(cause: unknown): ConversionError {
  if (isConversionError(cause)) {
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
