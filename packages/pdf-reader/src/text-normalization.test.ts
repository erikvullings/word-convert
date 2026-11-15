import { describe, expect, it } from 'vitest';
import type { BlockNode } from '@wordconvert/document-model';
import {
  collectWordEvidence,
  dehyphenateBodyBlocks,
  MAX_PDF_WORD_EVIDENCE,
} from './text-normalization.ts';

describe('PDF text normalization', () => {
  it('uses body evidence while preserving ambiguous, code, linked, and URL text', async () => {
    const blocks: BlockNode[] = [
      {
        type: 'paragraph',
        styleId: 'body',
        children: [
          { type: 'text', text: 'international inter-national ' },
          { type: 'text', text: 're-cover re-cover recover recover ' },
          { type: 'text', text: 'single-occurrence ' },
          {
            type: 'text',
            text: 'https://example.org/inter-national ',
          },
          {
            type: 'text',
            text: 'inter-national',
            marks: [{ type: 'code' }],
          },
          {
            type: 'link',
            href: 'https://example.org/inter-national',
            children: [{ type: 'text', text: 'inter-national' }],
          },
          { type: 'text', text: ' soft\u00adhyphen' },
        ],
      },
    ];
    const evidence = await collectWordEvidence(
      ['international recover recover', 're-cover re-cover', 'inter-national'],
      async () => {},
    );

    const summary = await dehyphenateBodyBlocks(
      blocks,
      new Set(['body']),
      evidence,
      async () => {},
    );
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('Expected paragraph');
    const plainText = paragraph.children
      .filter((node) => node.type === 'text')
      .map((node) => (node.type === 'text' ? node.text : ''))
      .join('');

    expect(plainText).toContain('international international');
    expect(plainText).toContain('re-cover re-cover recover recover');
    expect(plainText).toContain('single-occurrence');
    expect(plainText).toContain('https://example.org/inter-national');
    expect(plainText).toContain('inter-national');
    expect(plainText).toContain('softhyphen');
    expect(plainText).not.toContain('\u00ad');
    expect(summary).toMatchObject({ joined: 2, kept: 3, limitExceeded: false });
  });

  it('does not dehyphenate when a word lacks independent evidence', async () => {
    const evidence = await collectWordEvidence(['co-operate'], async () => {});
    const blocks: BlockNode[] = [
      {
        type: 'paragraph',
        styleId: 'body',
        children: [{ type: 'text', text: 'co-operate' }],
      },
    ];

    const summary = await dehyphenateBodyBlocks(
      blocks,
      new Set(['body']),
      evidence,
      async () => {},
    );

    expect(blocks).toMatchObject([{ children: [{ text: 'co-operate' }] }]);
    expect(summary).toMatchObject({ joined: 0, kept: 1 });
  });

  it('uses Unicode-normalized evidence for German words and preserves case', async () => {
    const blocks: BlockNode[] = [
      {
        type: 'paragraph',
        styleId: 'body',
        children: [{ type: 'text', text: 'Donaudampf-schiff' }],
      },
    ];
    const evidence = await collectWordEvidence(
      ['Donaudampfschiff'],
      async () => {},
    );

    await dehyphenateBodyBlocks(
      blocks,
      new Set(['body']),
      evidence,
      async () => {},
    );

    expect(blocks).toMatchObject([
      { children: [{ text: 'Donaudampfschiff' }] },
    ]);
  });

  it('preserves non-body paragraphs and code blocks', async () => {
    const blocks: BlockNode[] = [
      {
        type: 'paragraph',
        styleId: 'heading',
        children: [{ type: 'text', text: 'inter-national' }],
      },
      { type: 'codeBlock', text: 'inter-national', language: 'text' },
    ];
    const evidence = await collectWordEvidence(
      ['international'],
      async () => {},
    );

    await dehyphenateBodyBlocks(
      blocks,
      new Set(['body']),
      evidence,
      async () => {},
    );

    expect(blocks).toMatchObject([
      { children: [{ text: 'inter-national' }] },
      { text: 'inter-national' },
    ]);
  });

  it('stops collecting word evidence at the deterministic budget', async () => {
    const evidence = await collectWordEvidence(
      [`international ${'x '.repeat(MAX_PDF_WORD_EVIDENCE)}`],
      async () => {},
    );
    const blocks: BlockNode[] = [
      {
        type: 'paragraph',
        styleId: 'body',
        children: [{ type: 'text', text: 'inter-national soft\u00adhyphen' }],
      },
    ];

    const summary = await dehyphenateBodyBlocks(
      blocks,
      new Set(['body']),
      evidence,
      async () => {},
    );

    expect(evidence.limitExceeded).toBe(true);
    expect(evidence.words.size).toBe(0);
    expect(blocks).toMatchObject([
      { children: [{ text: 'inter-national softhyphen' }] },
    ]);
    expect(summary).toMatchObject({
      joined: 1,
      kept: 1,
      limitExceeded: true,
    });
  });
});
