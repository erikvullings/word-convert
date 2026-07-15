import { describe, expect, it } from 'vitest';

import {
  acceptHighConfidenceMappings,
  exportStylePreset,
  importStylePreset,
  setMetadataField,
  updateAuthor,
} from './editors.ts';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

const model = {
  schema: DOCUMENT_MODEL_SCHEMA,
  version: DOCUMENT_MODEL_VERSION,
  metadata: {
    authors: [
      {
        value: { name: 'Ada', role: 'author' },
        provenance: {
          source: 'core properties',
          method: 'extracted',
          confidence: 'certain',
        },
      },
    ],
    subjects: [],
    conversionDate: {
      value: '2026-07-15',
      provenance: {
        source: 'conversion settings',
        method: 'default',
        confidence: 'certain',
      },
    },
  },
  styles: [
    {
      id: 'StrongHeading',
      kind: 'paragraph',
      formatting: {},
      usageCount: 2,
      examples: ['One'],
      proposedMapping: 'heading1',
      reasons: ['Outline level'],
      provenance: {
        source: 'style analysis',
        method: 'inferred',
        confidence: 'high',
      },
    },
    {
      id: 'Uncertain',
      kind: 'paragraph',
      formatting: {},
      usageCount: 1,
      examples: ['Two'],
      proposedMapping: 'blockquote',
      reasons: ['Name resembles quote'],
      provenance: {
        source: 'style analysis',
        method: 'inferred',
        confidence: 'medium',
      },
    },
  ],
  blocks: [],
  assets: {},
  equations: {},
  notes: {},
  warnings: [],
} satisfies DocumentModel;

describe('style editor state', () => {
  it('accepts only high-confidence proposals without replacing user edits', () => {
    expect(
      acceptHighConfidenceMappings(model.styles, { Uncertain: 'caption' }),
    ).toEqual({ StrongHeading: 'heading1', Uncertain: 'caption' });
  });

  it('round-trips a versioned preset and rejects malformed, unknown, or polluted input', () => {
    const json = exportStylePreset({
      Heading1: 'heading1',
      Quote: 'blockquote',
    });
    expect(importStylePreset(json)).toEqual({
      ok: true,
      mappings: { Heading1: 'heading1', Quote: 'blockquote' },
    });
    expect(
      importStylePreset(
        '{"schema":"wordconvert.style-preset","version":2,"mappings":{}}',
      ).ok,
    ).toBe(false);
    expect(
      importStylePreset(
        '{"schema":"wordconvert.style-preset","version":1,"mappings":{"x":"script"}}',
      ).ok,
    ).toBe(false);
    expect(importStylePreset('{"__proto__":{"polluted":true}}').ok).toBe(false);
  });
});

describe('metadata editor state', () => {
  it('marks scalar and structured author edits as user-provided while preserving other metadata', () => {
    const titled = setMetadataField(model.metadata, 'title', 'Edited title');
    const edited = updateAuthor(titled, 0, {
      name: 'Ada Lovelace',
      sortAs: 'Lovelace, Ada',
      role: 'author',
      identifier: 'https://orcid.org/0000-0000',
    });

    expect(edited.title).toMatchObject({
      value: 'Edited title',
      provenance: { method: 'user', confidence: 'certain' },
    });
    expect(edited.authors[0]).toMatchObject({
      value: { name: 'Ada Lovelace', sortAs: 'Lovelace, Ada' },
      provenance: { method: 'user', confidence: 'certain' },
    });
    expect(edited.conversionDate).toEqual(model.metadata.conversionDate);
  });
});
