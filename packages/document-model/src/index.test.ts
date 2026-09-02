import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  deserializeDocumentModel,
  isConversionError,
  serializeDocumentModel,
  toJsonValue,
  validateDocumentModel,
  type BinaryWriter,
  type ConversionError,
  type DocxReader,
  type DocumentModel,
  type OperationControlMessage,
  type TextWriter,
} from './index.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

const model: DocumentModel = {
  schema: DOCUMENT_MODEL_SCHEMA,
  version: DOCUMENT_MODEL_VERSION,
  metadata: {
    authors: [],
    subjects: [],
    conversionDate: {
      value: '2026-07-14',
      provenance: {
        source: 'options.conversionDate',
        method: 'default',
        confidence: 'certain',
      },
    },
  },
  blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] }],
  assets: {
    image1: {
      id: 'image1',
      mediaType: 'image/png',
      data: new Uint8Array([0, 127, 255]),
    },
  },
  equations: {
    equation1: {
      id: 'equation1',
      source: { format: 'omml', value: '<m:oMath />' },
      tex: 'x^2',
      conversionComplete: false,
      display: 'inline',
      recognition: {
        method: 'pdf-geometry',
        confidence: 0.7,
        model: 'test-recognizer',
      },
      location: {
        kind: 'pdf',
        page: 2,
        x: 0.2,
        top: 0.3,
        width: 0.1,
        height: 0.02,
        spanIds: ['pdf-span-2-4'],
      },
      review: { status: 'edited', originalTex: 'x2' },
    },
  },
  notes: {
    note1: {
      id: 'note1',
      kind: 'footnote',
      blocks: [{ type: 'paragraph', children: [] }],
    },
  },
  styles: [],
  warnings: [],
};

describe('DocumentModel contracts', () => {
  it('round-trips binary values through explicit JSON encoding', () => {
    const json = serializeDocumentModel(model);
    expect(json).toContain('"$binary":"uint8-array"');
    expect(deserializeDocumentModel(json)).toEqual(model);
  });

  it('produces JSON-safe values and rejects unsupported values', () => {
    expect(JSON.parse(JSON.stringify(toJsonValue(model)))).toBeDefined();
    expect(() => toJsonValue(new Date())).toThrow('Unsupported JSON value');
    expect(() => toJsonValue(Number.NaN)).toThrow('non-finite');
  });

  it('reports schema, collection, and binary validation issues', () => {
    const result = validateDocumentModel({
      ...model,
      version: 2,
      blocks: {},
      assets: { bad: { data: [1] } },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map(({ path }) => path)).toEqual([
      'version',
      'blocks',
      'assets.bad.data',
    ]);
  });

  it('recognizes structured errors without requiring Error instances', () => {
    const error: ConversionError = {
      code: 'unsupported-format',
      message: 'Only DOCX files are supported.',
      recoverable: false,
    };
    expect(isConversionError(error)).toBe(true);
    expect(isConversionError(new Error('opaque'))).toBe(false);
  });

  it('keeps progress and cancellation messages serializable', () => {
    const messages: OperationControlMessage[] = [
      {
        type: 'progress',
        operationId: 'conversion-1',
        progress: { phase: 'read', completed: 1, total: 2 },
      },
      { type: 'cancel', operationId: 'conversion-1' },
    ];
    expect(JSON.parse(JSON.stringify(toJsonValue(messages)))).toEqual(messages);
  });

  it('exposes reader and writer boundaries with typed arrays and plain data', () => {
    const contracts: [
      Assert<Equal<Parameters<DocxReader['read']>[0], Uint8Array>>,
      Assert<Equal<ReturnType<TextWriter['write']>, string>>,
      Assert<Equal<ReturnType<BinaryWriter['write']>, Promise<Uint8Array>>>,
    ] = [true, true, true];

    expect(contracts).toEqual([true, true, true]);
  });
});
