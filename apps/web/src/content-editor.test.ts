import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import { markdownToBlocks, withMarkdownContent } from './content-editor.ts';

function model(): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-08-30',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks: [],
    assets: {
      diagram: {
        id: 'diagram',
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      },
    },
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}

describe('EPUB content editor', () => {
  it('converts edited Markdown to semantic document blocks', () => {
    const blocks = markdownToBlocks(
      [
        '## Revised chapter',
        '',
        'A **corrected** paragraph with [a reference](#details).',
        '',
        '- First item',
        '- Second item',
      ].join('\n'),
      model(),
    );

    expect(blocks).toMatchObject([
      {
        type: 'heading',
        level: 2,
        children: [{ type: 'text', text: 'Revised chapter' }],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'A ' },
          {
            type: 'text',
            text: 'corrected',
            marks: [{ type: 'bold' }],
          },
          { type: 'text', text: ' paragraph with ' },
          {
            type: 'link',
            href: '#details',
            children: [{ type: 'text', text: 'a reference' }],
          },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          {
            blocks: [{ type: 'paragraph', children: [{ text: 'First item' }] }],
          },
          {
            blocks: [
              { type: 'paragraph', children: [{ text: 'Second item' }] },
            ],
          },
        ],
      },
    ]);
  });

  it('retains images generated from existing document assets', () => {
    expect(
      markdownToBlocks('![Diagram](data:image/png;base64,AQID)', model()),
    ).toMatchObject([
      { type: 'paragraph', children: [{ type: 'image', assetId: 'diagram' }] },
    ]);
  });

  it('replaces only document blocks when applying edited content', () => {
    const original = model();
    const edited = withMarkdownContent(original, 'Corrected text');

    expect(edited).not.toBe(original);
    expect(edited.blocks).toMatchObject([
      { type: 'paragraph', children: [{ text: 'Corrected text' }] },
    ]);
    expect(edited.metadata).toBe(original.metadata);
    expect(edited.assets).toBe(original.assets);
  });
});
