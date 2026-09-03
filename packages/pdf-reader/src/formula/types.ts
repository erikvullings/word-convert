import type { CancellationSignal } from '@wordconvert/document-model';

export interface PdfBounds {
  x: number;
  top: number;
  width: number;
  height: number;
}

export type PdfFormulaConfidence = 'low' | 'medium' | 'high';
export type PdfFormulaSource =
  | 'heron'
  | 'geometry'
  | 'font'
  | 'symbols'
  | 'tagged-structure'
  | 'rasterized-equation'
  | 'manual';

export interface PdfManualFormulaRegion {
  id: string;
  page: number;
  bounds: PdfBounds;
  kind: 'inline' | 'display';
  forceRecognition?: boolean;
  skipRecognition?: boolean;
  sourceImageId?: string;
}

export interface PdfFormulaImageRegion {
  id: string;
  page: number;
  bounds: PdfBounds;
}

export interface PdfMathFeatures {
  mathFontRatio: number;
  operatorRatio: number;
  greekRatio: number;
  symbolRatio: number;
  singleLetterTokenRatio: number;
  dictionaryLikeWordRatio: number;
  superscriptCount: number;
  subscriptCount: number;
  baselineVariance: number;
  fontSizeVariance: number;
  centered: boolean;
  isolated: boolean;
  equationNumberAtRight: boolean;
  multilineStructure: boolean;
  heronFormulaConfidence?: number;
  score: number;
  confidence: PdfFormulaConfidence;
}

export interface PdfFormulaCandidate {
  id: string;
  page: number;
  kind: 'inline' | 'display' | 'unknown';
  bounds: PdfBounds;
  spanIds: string[];
  features: PdfMathFeatures;
  score: number;
  confidence: PdfFormulaConfidence;
  sources: PdfFormulaSource[];
  sourceImageId?: string;
  tex?: string;
  requiresRecognition: boolean;
  recognition?: PdfFormulaRecognition & {
    model: string;
    reviewConfidence: PdfFormulaConfidence;
  };
  recognitionFailure?:
    'unavailable' | 'failed' | 'invalid-tex' | 'limit-exceeded';
}

export interface PdfFormulaImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface PdfFormulaRecognition {
  tex: string;
  confidence?: number;
  diagnostics?: {
    tokens?: number;
    backend?: 'webgpu' | 'wasm';
  };
}

export interface PdfFormulaRecognizer {
  readonly implementation: string;
  recognize(
    image: PdfFormulaImage,
    options?: { cancellation?: CancellationSignal },
  ): Promise<PdfFormulaRecognition>;
  dispose?(): Promise<void>;
}

export interface PdfFormulaDecision {
  equationId: string;
  decision: 'formula' | 'text' | 'image';
  tex?: string;
  display?: 'inline' | 'block';
  accepted?: boolean;
}

export interface PdfFormulaLimits {
  maxCandidatesPerPage: number;
  maxCandidatesTotal: number;
  maxCropPixels: number;
  maxTotalCropPixels: number;
  maxRecognitionTokens: number;
}
