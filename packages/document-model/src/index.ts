export const DOCUMENT_MODEL_SCHEMA = 'wordconvert.document' as const;
export const DOCUMENT_MODEL_VERSION = 1 as const;

export type Confidence = 'low' | 'medium' | 'high' | 'certain';

export interface Provenance {
  source: string;
  location?: string;
  method: 'extracted' | 'inferred' | 'default' | 'user';
  confidence: Confidence;
  reason?: string;
}

export interface InferredValue<T> {
  value: T;
  provenance: Provenance;
}

export interface Person {
  name: string;
  sortAs?: string;
  role?: string;
  identifier?: string;
}

export interface DocumentMetadata {
  title?: InferredValue<string>;
  subtitle?: InferredValue<string>;
  authors: InferredValue<Person>[];
  language?: InferredValue<string>;
  publisher?: InferredValue<string>;
  description?: InferredValue<string>;
  subjects: InferredValue<string>[];
  version?: InferredValue<string>;
  sourceCreatedAt?: InferredValue<string>;
  sourceModifiedAt?: InferredValue<string>;
  publicationDate?: InferredValue<string>;
  conversionDate: InferredValue<string>;
  identifier?: InferredValue<string>;
  rights?: InferredValue<string>;
}

export interface TextInline {
  type: 'text';
  text: string;
  marks?: TextMark[];
}

export type TextMark =
  | {
      type:
        | 'bold'
        | 'italic'
        | 'underline'
        | 'strikethrough'
        | 'subscript'
        | 'superscript';
    }
  | { type: 'code' }
  | { type: 'style'; styleId: string };

export interface LinkInline {
  type: 'link';
  href: string;
  children: InlineNode[];
  title?: string;
}

export interface ImageInline {
  type: 'image';
  assetId: string;
  alt?: string;
  title?: string;
}

export interface EquationInline {
  type: 'equation';
  equationId: string;
}

export interface NoteReferenceInline {
  type: 'noteReference';
  noteId: string;
}

export interface BreakInline {
  type: 'lineBreak' | 'softBreak';
}

export type InlineNode =
  | TextInline
  | LinkInline
  | ImageInline
  | EquationInline
  | NoteReferenceInline
  | BreakInline;

export interface ParagraphNode {
  type: 'paragraph';
  children: InlineNode[];
  styleId?: string;
}

export interface HeadingNode {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineNode[];
  styleId?: string;
  id?: string;
}

export interface ListNode {
  type: 'list';
  ordered: boolean;
  start?: number;
  items: ListItem[];
}

export interface ListItem {
  blocks: BlockNode[];
}

export interface TableNode {
  type: 'table';
  rows: TableRow[];
  caption?: InlineNode[];
}

export interface TableRow {
  cells: TableCell[];
}

export interface TableCell {
  blocks: BlockNode[];
  header?: boolean;
  colSpan?: number;
  rowSpan?: number;
}

export interface BlockQuoteNode {
  type: 'blockquote';
  blocks: BlockNode[];
}

export interface CodeBlockNode {
  type: 'codeBlock';
  text: string;
  language?: string;
}

export interface EquationBlockNode {
  type: 'equationBlock';
  equationId: string;
}

export interface ImageBlockNode {
  type: 'imageBlock';
  assetId: string;
  alt?: string;
  caption?: InlineNode[];
}

export interface ThematicBreakNode {
  type: 'thematicBreak' | 'pageBreak';
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | ListNode
  | TableNode
  | BlockQuoteNode
  | CodeBlockNode
  | EquationBlockNode
  | ImageBlockNode
  | ThematicBreakNode;

export interface DocumentAsset {
  id: string;
  mediaType: string;
  data: Uint8Array;
  filename?: string;
  width?: number;
  height?: number;
}

export interface Equation {
  id: string;
  source: { format: 'omml' | 'tex' | 'mathml'; value: string };
  tex?: string;
  mathml?: string;
  conversionComplete: boolean;
}

export interface Note {
  id: string;
  kind: 'footnote' | 'endnote';
  blocks: BlockNode[];
}

export type StyleMapping =
  | 'title'
  | 'subtitle'
  | 'author'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'body'
  | 'blockquote'
  | 'caption'
  | 'footnote'
  | 'code'
  | 'ignore';

export interface EffectiveFormatting {
  fontFamily?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  outlineLevel?: number;
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  indentationLeftPt?: number;
  indentationRightPt?: number;
  indentationFirstLinePt?: number;
  numbering?: string;
}

export interface AnalysedStyle {
  id: string;
  name?: string;
  kind: 'paragraph' | 'character';
  basedOn?: string;
  formatting: EffectiveFormatting;
  usageCount: number;
  examples: string[];
  proposedMapping: StyleMapping;
  reasons: string[];
  provenance: Provenance;
}

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface ConversionWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  location?: string;
  details?: Record<string, string | number | boolean>;
}

export interface DocumentModel {
  schema: typeof DOCUMENT_MODEL_SCHEMA;
  version: typeof DOCUMENT_MODEL_VERSION;
  metadata: DocumentMetadata;
  blocks: BlockNode[];
  assets: Record<string, DocumentAsset>;
  equations: Record<string, Equation>;
  notes: Record<string, Note>;
  styles: AnalysedStyle[];
  warnings: ConversionWarning[];
}

export type ProgressPhase =
  'inspect' | 'read' | 'analyse' | 'convert' | 'write';

export interface ConversionProgress {
  phase: ProgressPhase;
  completed: number;
  total?: number;
  message?: string;
}

export type OperationControlMessage =
  | { type: 'cancel'; operationId: string }
  | { type: 'progress'; operationId: string; progress: ConversionProgress };

/** A mutable plain object can be shared by in-process callers; workers use cancellation messages. */
export interface CancellationSignal {
  cancelled: boolean;
}

export interface ConversionOptions {
  /** Required ISO 8601 value supplied by the caller; implementations must not read the clock. */
  conversionDate: string;
  cancellation?: CancellationSignal;
  onProgress?: (progress: ConversionProgress) => void;
}

export interface DocxReaderOptions extends ConversionOptions {
  filename?: string;
  stylePreset?: Readonly<Record<string, StyleMapping>>;
  styleMappings?: Readonly<Record<string, StyleMapping>>;
  limits?: {
    maxCompressedBytes?: number;
    maxUncompressedBytes?: number;
    maxEntries?: number;
    maxCompressionRatio?: number;
  };
}

export interface DocxReader {
  readonly implementation: string;
  read(input: Uint8Array, options: DocxReaderOptions): Promise<DocumentModel>;
}

export interface WriterOptions extends ConversionOptions {}

export interface TextWriter<O extends WriterOptions = WriterOptions> {
  write(model: DocumentModel, options: O): string;
}

export interface BinaryWriter<O extends WriterOptions = WriterOptions> {
  write(model: DocumentModel, options: O): Promise<Uint8Array>;
}

export type ConversionErrorCode =
  | 'cancelled'
  | 'invalid-input'
  | 'unsupported-format'
  | 'encrypted-document'
  | 'resource-limit'
  | 'invalid-model'
  | 'conversion-failed';

export interface ConversionError {
  code: ConversionErrorCode;
  message: string;
  phase?: ProgressPhase;
  recoverable: boolean;
  details?: Record<string, string | number | boolean>;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateDocumentModel(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: '', code: 'type', message: 'Expected an object.' }],
    };
  }
  if (value.schema !== DOCUMENT_MODEL_SCHEMA) {
    issues.push({
      path: 'schema',
      code: 'schema',
      message: `Expected ${DOCUMENT_MODEL_SCHEMA}.`,
    });
  }
  if (value.version !== DOCUMENT_MODEL_VERSION) {
    issues.push({
      path: 'version',
      code: 'version',
      message: `Unsupported model version: ${String(value.version)}.`,
    });
  }
  for (const key of ['metadata', 'assets', 'equations', 'notes'] as const) {
    if (!isRecord(value[key]))
      issues.push({ path: key, code: 'type', message: 'Expected an object.' });
  }
  for (const key of ['blocks', 'styles', 'warnings'] as const) {
    if (!Array.isArray(value[key]))
      issues.push({ path: key, code: 'type', message: 'Expected an array.' });
  }
  if (isRecord(value.assets)) {
    for (const [id, asset] of Object.entries(value.assets)) {
      if (!isRecord(asset) || !(asset.data instanceof Uint8Array)) {
        issues.push({
          path: `assets.${id}.data`,
          code: 'binary',
          message: 'Expected Uint8Array data.',
        });
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export interface JsonBinary {
  $binary: 'uint8-array';
  bytes: number[];
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Encodes typed arrays explicitly so the model can cross a JSON-only WASM boundary. */
export function toJsonValue(value: unknown): JsonValue {
  if (value instanceof Uint8Array)
    return { $binary: 'uint8-array', bytes: Array.from(value) };
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('JSON values cannot contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) output[key] = toJsonValue(child);
    }
    return output;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}.`);
}

export function fromJsonValue(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map(fromJsonValue);
  if (isRecord(value)) {
    if (value.$binary === 'uint8-array' && Array.isArray(value.bytes)) {
      if (
        !value.bytes.every(
          (byte) =>
            typeof byte === 'number' &&
            Number.isInteger(byte) &&
            byte >= 0 &&
            byte <= 255,
        )
      ) {
        throw new TypeError('Invalid byte in uint8-array JSON value.');
      }
      return Uint8Array.from(value.bytes as number[]);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        fromJsonValue(child as JsonValue),
      ]),
    );
  }
  return value;
}

export function serializeDocumentModel(model: DocumentModel): string {
  return JSON.stringify(toJsonValue(model));
}

export function deserializeDocumentModel(json: string): DocumentModel {
  const value: unknown = fromJsonValue(JSON.parse(json) as JsonValue);
  const result = validateDocumentModel(value);
  if (!result.valid)
    throw new TypeError(
      result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('\n'),
    );
  return value as DocumentModel;
}

export function isConversionError(value: unknown): value is ConversionError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.recoverable === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
