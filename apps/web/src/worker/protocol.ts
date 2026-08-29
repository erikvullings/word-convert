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
import type {
  PdfAnalysisSummary,
  PdfCropOptions,
} from '@wordconvert/pdf-reader';

export interface PdfWorkerOptions {
  crop?: Partial<PdfCropOptions>;
  removeDetectedFurniture?: boolean;
  removedCandidateIds?: string[];
  retainedCandidateIds?: string[];
}

export type WorkerRequest =
  | {
      type: 'analyse';
      operationId: string;
      input: ArrayBuffer;
      filename: string;
      sourceFormat?: 'docx' | 'pdf';
      conversionDate: string;
      styleMappings?: Readonly<Record<string, StyleMapping>>;
      pdfOptions?: PdfWorkerOptions;
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
  | {
      type: 'pdf-page-preview';
      operationId: string;
      input: ArrayBuffer;
      pageNumber: number;
    }
  | { type: 'cancel'; operationId: string };

export type WorkerResponse =
  | { type: 'progress'; operationId: string; progress: ConversionProgress }
  | {
      type: 'analysed';
      operationId: string;
      model: DocumentModel;
      pdfAnalysis?: PdfAnalysisSummary;
    }
  | {
      type: 'output';
      operationId: string;
      filename: string;
      mediaType: string;
      data: ArrayBuffer;
      files?: string[];
      warnings?: ConversionWarning[];
    }
  | {
      type: 'pdf-page-preview';
      operationId: string;
      pageNumber: number;
      width: number;
      height: number;
      data: ArrayBuffer;
    }
  | { type: 'error'; operationId: string; error: ConversionError };

export type WorkerSend = (
  response: WorkerResponse,
  transfer?: Transferable[],
) => void;
