import type {
  ConversionError,
  ConversionProgress,
  DocumentModel,
  StyleMapping,
} from '@wordconvert/document-model';
import type { CoverComposition } from '@wordconvert/cover-generator';

export type WorkerRequest =
  | {
      type: 'analyse';
      operationId: string;
      input: ArrayBuffer;
      filename: string;
      conversionDate: string;
      styleMappings?: Readonly<Record<string, StyleMapping>>;
    }
  | {
      type: 'convert';
      operationId: string;
      model: DocumentModel;
      filename: string;
      format: 'html' | 'markdown' | 'epub';
      conversionDate: string;
      cover?: CoverComposition;
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
      files?: string[];
    }
  | { type: 'error'; operationId: string; error: ConversionError };

export type WorkerSend = (
  response: WorkerResponse,
  transfer?: Transferable[],
) => void;
