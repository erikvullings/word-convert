import type {
  ConversionError,
  ConversionErrorCode,
} from '@wordconvert/document-model';

export class DocxReadError extends Error implements ConversionError {
  readonly recoverable = false;
  readonly phase = 'read' as const;
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    readonly code: ConversionErrorCode,
    message: string,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'DocxReadError';
    if (details) this.details = details;
  }
}

export function fail(
  code: ConversionErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>,
): never {
  throw new DocxReadError(code, message, details);
}
