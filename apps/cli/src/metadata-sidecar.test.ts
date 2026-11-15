import { describe, expect, it } from 'vitest';
import {
  applyMetadataSidecar,
  isValidIsbn,
  MAX_METADATA_FILE_BYTES,
  parseMetadataSidecar,
} from './metadata-sidecar.ts';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
} from '@wordconvert/document-model';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function sidecar(metadata: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 'wordconvert.metadata',
    version: 1,
    metadata,
  });
}

describe('metadata sidecar', () => {
  it('parses bounded version 1 metadata and canonicalizes its dates and language', () => {
    expect(
      parseMetadataSidecar(
        encode(
          sidecar({
            title: 'Sidecar title',
            version: '2.1',
            language: 'en-us',
            publicationDate: '2024-06-07T10:00:00+02:00',
            subjects: ['One', 'Two'],
            authors: ['Ada Example'],
            contributors: ['Editor One'],
            series: 'Field Notes',
            seriesIndex: 2,
          }),
        ),
      ),
    ).toEqual({
      title: 'Sidecar title',
      version: '2.1',
      language: 'en-US',
      publicationDate: '2024-06-07T08:00:00Z',
      subjects: ['One', 'Two'],
      authors: ['Ada Example'],
      contributors: ['Editor One'],
      series: 'Field Notes',
      seriesIndex: 2,
    });
  });

  it('rejects unknown keys, unsupported versions, malformed dates, URLs, and oversized input', () => {
    for (const json of [
      JSON.stringify({
        schema: 'wordconvert.metadata',
        version: 1,
        metadata: { title: 'Title', cover: 'cover.png' },
      }),
      sidecar({ title: 'Title', mystery: 'value' }),
      JSON.stringify({
        schema: 'wordconvert.metadata',
        version: 2,
        metadata: {},
      }),
      sidecar({ publicationDate: '2026-02-30' }),
      sidecar({ identifier: 'https://example.test/book' }),
    ])
      expect(() => parseMetadataSidecar(encode(json))).toThrow();
    expect(() =>
      parseMetadataSidecar(new Uint8Array(MAX_METADATA_FILE_BYTES + 1)),
    ).toThrow('exceeds');
  });

  it('allows checksum-invalid ISBNs for warning-mode handling and validates checksums', () => {
    const parsed = parseMetadataSidecar(
      encode(sidecar({ isbn: '9780306406158' })),
    );
    expect(parsed.isbn).toBe('9780306406158');
    expect(isValidIsbn('0-306-40615-2')).toBe(true);
    expect(isValidIsbn('978-0-306-40615-7')).toBe(true);
    expect(isValidIsbn(parsed.isbn ?? '')).toBe(false);
  });

  it('applies values with user provenance without changing untouched inference', () => {
    const model = {
      schema: DOCUMENT_MODEL_SCHEMA,
      version: DOCUMENT_MODEL_VERSION,
      metadata: {
        title: {
          value: 'Reader title',
          provenance: {
            source: 'reader',
            method: 'inferred' as const,
            confidence: 'medium' as const,
          },
        },
        authors: [],
        subjects: [],
        conversionDate: {
          value: '2026-01-01',
          provenance: {
            source: 'conversion settings',
            method: 'default' as const,
            confidence: 'certain' as const,
          },
        },
      },
    };
    const result = applyMetadataSidecar(
      model.metadata,
      parseMetadataSidecar(encode(sidecar({ publisher: 'Publisher' }))),
    );
    expect(result.title).toEqual(model.metadata.title);
    expect(result.publisher).toMatchObject({
      value: 'Publisher',
      provenance: {
        source: 'metadata sidecar',
        method: 'user',
        confidence: 'certain',
      },
    });
  });
});
