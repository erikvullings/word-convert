import type {
  ConversionError,
  ConversionProgress,
  ConversionWarning,
  DocumentModel,
  StyleMapping,
} from '@wordconvert/document-model';
import type { CoverComposition } from '@wordconvert/cover-generator';
import type { MathOutputMode } from '@wordconvert/math-converter';
import type { ConversionMode } from '../output.ts';

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
      mode?: ConversionMode;
      conversionDate: string;
      cover?: CoverComposition;
      formulaMode?: MathOutputMode;
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
      warnings?: ConversionWarning[];
    }
  | { type: 'error'; operationId: string; error: ConversionError };

export type WorkerSend = (
  response: WorkerResponse,
  transfer?: Transferable[],
) => void;
