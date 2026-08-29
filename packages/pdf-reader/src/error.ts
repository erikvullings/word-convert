import type {
  ConversionErrorCode,
  ProgressPhase,
} from '@wordconvert/document-model';

export class PdfReadError extends Error {
  readonly code: ConversionErrorCode;
  readonly phase: ProgressPhase | undefined;
  readonly recoverable: boolean;
  readonly details: Record<string, string | number | boolean> | undefined;

  constructor(
    code: ConversionErrorCode,
    message: string,
    options: {
      phase?: ProgressPhase;
      recoverable?: boolean;
      details?: Record<string, string | number | boolean>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PdfReadError';
    this.code = code;
    this.phase = options.phase;
    this.recoverable = options.recoverable ?? false;
    this.details = options.details;
  }
}
