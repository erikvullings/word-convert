import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
  type ConversionWarning,
} from '@wordconvert/document-model';
import { strFromU8, unzipSync } from 'fflate';
import { writeMarkdown, writeMarkdownZip } from './index.ts';

function model(blocks: DocumentModel['blocks']): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-07-15',
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

describe('writeMarkdown', () => {
  it('applies source, MathML, KaTeX, and disabled formula modes', () => {
    const input = model([{ type: 'equationBlock', equationId: 'eq' }]);
    input.equations.eq = {
      id: 'eq',
      source: {
        format: 'omml',
        value: '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>',
      },
      tex: 'x',
      conversionComplete: true,
    };
    expect(
      writeMarkdown(input, {
        conversionDate: '2026-07-16',
        formulaMode: 'source',
      }),
    ).toContain('$$\nx\n$$');
    expect(
      writeMarkdown(input, {
        conversionDate: '2026-07-16',
        formulaMode: 'mathml',
      }),
    ).toContain('<math');
    expect(
      writeMarkdown(input, {
        conversionDate: '2026-07-16',
        formulaMode: 'katex',
      }),
    ).toContain('class="katex"');
    expect(
      writeMarkdown(input, {
        conversionDate: '2026-07-16',
        formulaMode: 'disabled',
      }),
    ).toBe('\n');
  });

  it('writes metadata title as the document title without duplicating a mapped title', () => {
    const input = model([
      {
        type: 'heading',
        level: 2,
        children: [{ type: 'text', text: 'Introduction' }],
      },
    ]);
    input.metadata.title = {
      value: 'Annual # report',
      provenance: {
        source: 'test',
        method: 'inferred',
        confidence: 'high',
      },
    };

    expect(writeMarkdown(input, { conversionDate: '2026-07-15' })).toBe(
      '# Annual \\# report\n\n## Introduction\n',
    );

    input.blocks.unshift({
      type: 'heading',
      level: 1,
      children: [{ type: 'text', text: 'Annual # report' }],
    });
    expect(
      writeMarkdown(input, { conversionDate: '2026-07-15' }).match(
        /Annual \\# report/g,
      ),
    ).toHaveLength(1);
  });

  it('writes headings, escaped paragraphs, formatting, and safe links', () => {
    const markdown = writeMarkdown(
      model([
        {
          type: 'heading',
          level: 2,
          children: [{ type: 'text', text: 'Overview' }],
        },
        {
          type: 'paragraph',
          children: [
            { type: 'text', text: 'Use *stars* ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'and code', marks: [{ type: 'code' }] },
            {
              type: 'link',
              href: 'https://example.com/a_(b)',
              title: 'Details "here"',
              children: [{ type: 'text', text: 'the [site]' }],
            },
          ],
        },
      ]),
      { conversionDate: '2026-07-15' },
    );

    expect(markdown).toBe(
      '## Overview\n\n**Use \\*stars\\* **`and code`[the \\[site\\]](https://example.com/a_\\(b\\) "Details \\"here\\"")\n',
    );
  });

  it('preserves supported formatting, quotes, code, and breaks', () => {
    const markdown = writeMarkdown(
      model([
        {
          type: 'paragraph',
          children: [
            { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
            {
              type: 'text',
              text: ' struck',
              marks: [{ type: 'strikethrough' }],
            },
            { type: 'text', text: ' under', marks: [{ type: 'underline' }] },
            { type: 'text', text: ' sub', marks: [{ type: 'subscript' }] },
            { type: 'text', text: ' super', marks: [{ type: 'superscript' }] },
            { type: 'lineBreak' },
            { type: 'text', text: 'next' },
          ],
        },
        {
          type: 'blockquote',
          blocks: [
            { type: 'paragraph', children: [{ type: 'text', text: 'Line 1' }] },
            { type: 'paragraph', children: [{ type: 'text', text: 'Line 2' }] },
          ],
        },
        {
          type: 'codeBlock',
          language: 'Type Script!',
          text: 'const x = `a`;\n',
        },
        { type: 'thematicBreak' },
        { type: 'pageBreak' },
      ]),
      { conversionDate: '2026-07-15' },
    );

    expect(markdown).toContain(
      '_italic_~~ struck~~<u> under</u><sub> sub</sub><sup> super</sup>  \nnext',
    );
    expect(markdown).toContain('> Line 1\n>\n> Line 2');
    expect(markdown).toContain('```type-script\nconst x = `a`;\n```');
    expect(markdown).toContain('\n---\n');
    expect(markdown).toContain('<!-- page break -->');
  });

  it('writes ordered and unordered nested lists and GFM tables', () => {
    const markdown = writeMarkdown(
      model([
        {
          type: 'list',
          ordered: true,
          start: 3,
          items: [
            {
              blocks: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'Top' }],
                },
                {
                  type: 'list',
                  ordered: false,
                  items: [
                    {
                      blocks: [
                        {
                          type: 'paragraph',
                          children: [{ type: 'text', text: 'Nested' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              blocks: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'Second paragraph' }],
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          caption: [{ type: 'text', text: 'Results' }],
          rows: [
            {
              cells: [
                {
                  header: true,
                  blocks: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'A' }],
                    },
                  ],
                },
                {
                  header: true,
                  blocks: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'B' }],
                    },
                  ],
                },
              ],
            },
            {
              cells: [
                {
                  blocks: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'x | y' }],
                    },
                  ],
                },
                {
                  blocks: [
                    {
                      type: 'paragraph',
                      children: [
                        { type: 'text', text: 'line' },
                        { type: 'lineBreak' },
                        { type: 'text', text: 'two' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      { conversionDate: '2026-07-15' },
    );

    expect(markdown).toContain('3. Top\n   - Nested\n4. Second paragraph');
    expect(markdown).toContain(
      '*Results*\n\n| A | B |\n| --- | --- |\n| x \\| y | line<br>two |',
    );
  });

  it('embeds images, captions, math, and referenced notes', () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          { type: 'image', assetId: 'photo', alt: 'A [photo]', title: 'View' },
          { type: 'equation', equationId: 'inline' },
          { type: 'noteReference', noteId: 'n1' },
        ],
      },
      {
        type: 'imageBlock',
        assetId: 'photo',
        alt: 'Large',
        caption: [{ type: 'text', text: 'Figure one' }],
      },
      { type: 'equationBlock', equationId: 'block' },
    ]);
    input.assets.photo = {
      id: 'photo',
      mediaType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71]),
    };
    input.equations.inline = {
      id: 'inline',
      source: { format: 'tex', value: 'ignored' },
      tex: 'x + y',
      conversionComplete: true,
    };
    input.equations.block = {
      id: 'block',
      source: { format: 'omml', value: '<m:oMath/>' },
      mathml: '<math><mi>x</mi></math>',
      conversionComplete: false,
    };
    input.notes.n1 = {
      id: 'n1',
      kind: 'footnote',
      blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Note body' }] },
        {
          type: 'list',
          ordered: false,
          items: [
            {
              blocks: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'detail' }],
                },
              ],
            },
          ],
        },
      ],
    };

    const markdown = writeMarkdown(input, { conversionDate: '2026-07-15' });

    expect(markdown).toContain(
      '![A \\[photo\\]](data:image/png;base64,iVBORw== "View")$x + y$[^n1]',
    );
    expect(markdown).toContain(
      '![Large](data:image/png;base64,iVBORw==)\n\n*Figure one*',
    );
    expect(markdown).toContain('$$\n<math><mi>x</mi></math>\n$$');
    expect(markdown).toContain('[^n1]: Note body\n    \n    - detail');
  });

  it('writes a deterministic ZIP with safe unique POSIX image paths', async () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          { type: 'image', assetId: '../z', alt: 'Z' },
          { type: 'image', assetId: 'a\\b', alt: 'A' },
        ],
      },
    ]);
    input.assets['../z'] = {
      id: '../z',
      mediaType: 'image/png',
      filename: '../../same.png',
      data: new Uint8Array([1]),
    };
    input.assets['a\\b'] = {
      id: 'a\\b',
      mediaType: 'image/png',
      filename: '..\\same.png',
      data: new Uint8Array([2]),
    };

    const first = await writeMarkdownZip(input, {
      conversionDate: '2026-07-15',
    });
    const second = await writeMarkdownZip(input, {
      conversionDate: '2026-07-15',
    });
    const files = unzipSync(first);

    expect(first).toEqual(second);
    expect(Object.keys(files).sort()).toEqual([
      'document.md',
      'images/image-001.png',
      'images/image-002.png',
    ]);
    expect(strFromU8(files['document.md'] ?? new Uint8Array())).toContain(
      '![Z](images/image-001.png)![A](images/image-002.png)',
    );
    expect(
      Object.keys(files).every(
        (path) => !path.includes('..') && !path.includes('\\'),
      ),
    ).toBe(true);
  });

  it('escapes hostile input and reports unsupported content deterministically', () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'javascript:alert(1)',
            children: [{ type: 'text', text: 'unsafe' }],
          },
          {
            type: 'text',
            text: '<b>styled</b>',
            marks: [{ type: 'style', styleId: 'custom' }],
          },
          { type: 'image', assetId: 'missing' },
          { type: 'image', assetId: 'svg' },
          { type: 'equation', equationId: 'missing-equation' },
          { type: 'noteReference', noteId: 'missing-note' },
        ],
      },
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                colSpan: 2,
                rowSpan: 3,
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'cell' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    input.assets.svg = {
      id: 'svg',
      mediaType: 'image/svg+xml',
      data: new TextEncoder().encode('<svg onload="alert(1)"/>'),
    };
    const firstWarnings: ConversionWarning[] = [];
    const secondWarnings: ConversionWarning[] = [];

    const first = writeMarkdown(input, {
      conversionDate: '2026-07-15',
      onWarning: (warning) => firstWarnings.push(warning),
    });
    const second = writeMarkdown(input, {
      conversionDate: '2026-07-15',
      onWarning: (warning) => secondWarnings.push(warning),
    });

    expect(first).toBe(second);
    expect(firstWarnings).toEqual(secondWarnings);
    expect(first).toContain('unsafe\\<b\\>styled\\</b\\>');
    expect(first).not.toContain('javascript:');
    expect(first).not.toContain('image/svg+xml');
    expect(firstWarnings.map(({ code }) => code)).toEqual([
      'markdown-unsafe-link',
      'markdown-unsupported-style-mark',
      'markdown-missing-asset',
      'markdown-unsupported-image',
      'markdown-missing-equation',
      'markdown-table-span',
      'markdown-missing-note',
    ]);
    expect(firstWarnings[2]?.details).toEqual({ assetId: 'missing' });
    expect(firstWarnings[5]?.details).toEqual({ colSpan: 2, rowSpan: 3 });
  });

  it('chooses collision-free inline and block code fences', () => {
    const markdown = writeMarkdown(
      model([
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              text: 'value `inside`',
              marks: [{ type: 'code' }],
            },
          ],
        },
        {
          type: 'codeBlock',
          language: 'md',
          text: 'before\n```\nafter',
        },
      ]),
      { conversionDate: '2026-07-15' },
    );

    expect(markdown).toContain('`` value `inside` ``');
    expect(markdown).toContain('````md\nbefore\n```\nafter\n````');
  });
});
