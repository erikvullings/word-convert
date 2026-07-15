import type {
  ConversionError,
  ConversionProgress,
  DocumentModel,
} from '@wordconvert/document-model';

export type WorkerRequest =
  | {
      type: 'analyse';
      operationId: string;
      input: ArrayBuffer;
      filename: string;
      conversionDate: string;
    }
  | {
      type: 'convert';
      operationId: string;
      model: DocumentModel;
      format: 'html' | 'markdown';
      conversionDate: string;
    }
  | { type: 'cancel'; operationId: string };

export type WorkerResponse =
  | { type: 'progress'; operationId: string; progress: ConversionProgress }
  | { type: 'analysed'; operationId: string; model: DocumentModel }
  | {
      type: 'output';
      operationId: string;
      filename: string;
      mediaType: string;
      data: ArrayBuffer;
    }
  | { type: 'error'; operationId: string; error: ConversionError };

export type WorkerSend = (
  response: WorkerResponse,
  transfer?: Transferable[],
) => void;
