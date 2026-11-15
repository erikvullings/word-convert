import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  isSceneBreakOrnament,
  normalizeDocumentText,
  type BlockNode,
  type DocumentModel,
} from '../index.ts';

function model(blocks: BlockNode[], language = 'en'): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      language: {
        value: language,
        provenance: {
          source: 'test',
          method: 'extracted',
          confidence: 'high',
        },
      },
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-11-15',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks,
    assets: {},
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}

const paragraph = (text: string): BlockNode => ({
  type: 'paragraph',
  children: text ? [{ type: 'text', text }] : [],
});

describe('shared text normalization', () => {
  it('recognizes only curated short ornament lines', () => {
    // These are the ornament examples consumed by the PDF line-stage fixture.
    expect(
      ['***', '* * *', '· · ·', '⁂', '— — —'].every(isSceneBreakOrnament),
    ).toBe(true);
    expect(
      ['...', 'continued prose', 'Chapter 1', '***********'].some(
        isSceneBreakOrnament,
      ),
    ).toBe(false);
  });

  it('leaves uncentered ornaments and isolated blanks alone', async () => {
    const source = model([
      paragraph('Before'),
      paragraph('***'),
      paragraph('After'),
      paragraph(''),
      paragraph('Single blank stays'),
      { type: 'pageBreak' },
      paragraph(''),
      paragraph('After the page'),
    ]);

    await normalizeDocumentText(source);

    expect(source.blocks.map(({ type }) => type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'pageBreak',
      'paragraph',
      'paragraph',
    ]);
  });

  it('deletes confidently alternating blank paragraphs and maps blank runs to one break', async () => {
    const alternating = model([
      paragraph('one'),
      paragraph(''),
      paragraph('two'),
      paragraph(''),
      paragraph('three'),
      paragraph(''),
      paragraph('four'),
    ]);
    const run = model([
      paragraph('before'),
      paragraph(''),
      paragraph('   '),
      paragraph('after'),
    ]);

    await normalizeDocumentText(alternating);
    await normalizeDocumentText(run);

    expect(alternating.blocks.map(({ type }) => type)).toEqual(
      Array(4).fill('paragraph'),
    );
    expect(run.blocks.map(({ type }) => type)).toEqual([
      'paragraph',
      'thematicBreak',
      'paragraph',
    ]);

    const disabled = model([
      paragraph('before'),
      paragraph(''),
      paragraph(''),
      paragraph('after'),
    ]);
    await normalizeDocumentText(disabled, {
      sceneBreaks: false,
      blankParagraphs: false,
    });
    expect(disabled.blocks.map(({ type }) => type)).toEqual(
      Array(4).fill('paragraph'),
    );

    const replacement = model([
      paragraph('before'),
      { type: 'thematicBreak' },
      paragraph('after'),
    ]);
    await normalizeDocumentText(replacement, { sceneBreakMarker: 'dots' });
    expect(replacement.blocks).toMatchObject([
      { children: [{ text: 'before' }] },
      { children: [{ text: '· · ·' }] },
      { children: [{ text: 'after' }] },
    ]);
  });

  it('normalizes ligatures by default while preserving protected nodes and identity', async () => {
    const codeText = {
      type: 'text' as const,
      text: 'ﬁ code',
      marks: [{ type: 'code' as const }],
    };
    const marked = { type: 'italic' as const };
    const marks = [marked];
    const text = { type: 'text' as const, text: 'ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ Ĳ ĳ', marks };
    const link = {
      type: 'link' as const,
      href: 'https://example.test/ﬁ',
      children: [{ type: 'text' as const, text: 'ﬂ link label' }],
    };
    const source = model([
      {
        type: 'paragraph',
        children: [text, codeText, link],
      },
      { type: 'codeBlock', text: 'ﬃ' },
      { type: 'equationBlock', equationId: 'math' },
    ]);
    source.equations.math = {
      id: 'math',
      source: { format: 'tex', value: '\\mathrm{ﬁ}' },
      conversionComplete: false,
    };
    source.assets.image = {
      id: 'image',
      mediaType: 'image/png',
      data: new Uint8Array([0xfb, 0x01]),
    };

    const summary = await normalizeDocumentText(source);

    expect(text.text).toBe('ff fi fl ffi ffl st st IJ ij');
    expect(text.marks).toBe(marks);
    expect(text).toBe(
      source.blocks[0]?.type === 'paragraph'
        ? source.blocks[0].children[0]
        : null,
    );
    expect(codeText.text).toBe('ﬁ code');
    expect(link.href).toBe('https://example.test/ﬁ');
    expect(link.children[0]?.type === 'text' && link.children[0].text).toBe(
      'fl link label',
    );
    expect(source.blocks[1]).toMatchObject({ type: 'codeBlock', text: 'ﬃ' });
    expect(source.equations.math?.source.value).toBe('\\mathrm{ﬁ}');
    expect([...source.assets.image!.data]).toEqual([0xfb, 0x01]);
    expect(summary.ligatures).toBe(10);

    const retained = model([paragraph('ﬁ')]);
    await normalizeDocumentText(retained, { ligatures: false });
    expect(retained.blocks).toMatchObject([{ children: [{ text: 'ﬁ' }] }]);
  });

  it('smartens conservative punctuation using language and leaves numeric primes and URLs alone', async () => {
    const code = {
      type: 'text' as const,
      text: '"code"... --',
      marks: [{ type: 'code' as const }],
    };
    const source = model([
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            text: `He said, "Hello 'world'." We're ready... 3--5 and this -- that 5'10" https://example.test/a--b...`,
          },
          code,
        ],
      },
      { type: 'codeBlock', text: '"code"... --' },
    ]);

    const summary = await normalizeDocumentText(source, {
      smartenPunctuation: true,
    });

    expect(source.blocks).toMatchObject([
      {
        children: [
          {
            text: `He said, “Hello ‘world’.” We’re ready… 3–5 and this — that 5'10" https://example.test/a--b...`,
          },
          { text: '"code"... --', marks: [{ type: 'code' }] },
        ],
      },
      { type: 'codeBlock', text: '"code"... --' },
    ]);
    expect(code.text).toBe('"code"... --');
    expect(summary.punctuationSmartened).toBe(8);

    const french = model([paragraph('"Bonjour"')], 'fr-FR');
    await normalizeDocumentText(french, { smartenPunctuation: true });
    expect(french.blocks).toMatchObject([
      { children: [{ text: '«\u202fBonjour\u202f»' }] },
    ]);
  });

  it('unsmarten punctuation and remains byte-identical on a second pass', async () => {
    const source = model([paragraph('“Hi”…— 3–5')]);

    await normalizeDocumentText(source, { unsmartenPunctuation: true });
    const once = JSON.stringify(source);
    await normalizeDocumentText(source, { unsmartenPunctuation: true });
    const repeat = model([paragraph('“Hi”…— 3–5')]);
    await normalizeDocumentText(repeat, { unsmartenPunctuation: true });

    expect(source.blocks).toMatchObject([
      { children: [{ text: '"Hi"...-- 3--5' }] },
    ]);
    expect(JSON.stringify(source)).toBe(once);
    expect(JSON.stringify(repeat)).toBe(once);
  });

  it('uses the text budget without partially rewriting an oversized node', async () => {
    const value = 'ﬃ'.repeat(5_000_001);
    const source = model([paragraph(value)]);
    const summary = await normalizeDocumentText(source);

    expect(source.blocks).toMatchObject([{ children: [{ text: value }] }]);
    expect(summary).toMatchObject({ ligatures: 0, budgetExceeded: true });
    expect(source.warnings.at(-1)).toMatchObject({
      code: 'text-normalization-summary',
      severity: 'warning',
    });
  });
});
