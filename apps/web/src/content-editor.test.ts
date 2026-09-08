import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import {
  contentEditorSource,
  contentPartModel,
  contentPartSummaries,
  contentPartSplitHeadings,
  createContentPartState,
  createPracticalContentPartState,
  deleteContentPart,
  importContentDataImages,
  insertImageIntoContentPart,
  markdownToBlocks,
  mergeContentPart,
  saveContentPart,
  splitContentPart,
  unsupportedContentImageSources,
  withMarkdownContent,
} from './content-editor.ts';

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
  it('inserts a source-page image before the active part trailing page break', () => {
    const document = model();
    document.blocks = [
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'Body' }] },
      { type: 'pageBreak' },
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'Two' }] },
    ];
    const state = { starts: [0, 3], activeIndex: 0 };

    const inserted = insertImageIntoContentPart(document, state, {
      id: 'editor-image-0001',
      mediaType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
      filename: 'editor-image-0001.png',
    });

    expect(inserted.model.blocks.map(({ type }) => type)).toEqual([
      'heading',
      'paragraph',
      'imageBlock',
      'pageBreak',
      'heading',
    ]);
    expect(inserted.model.assets['editor-image-0001']).toBeDefined();
    expect(inserted.state).toEqual({ starts: [0, 4], activeIndex: 0 });
  });

  it('derives ordered editor parts from top-level chapter headings', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      ['Preface', '', '# Chapter one', '', 'First.', '', '# Chapter two'].join(
        '\n',
      ),
      document,
    );

    const parts = contentPartSummaries(
      document,
      createContentPartState(document),
    );

    expect(parts).toEqual([
      { start: 0, end: 1, title: 'Front matter' },
      { start: 1, end: 3, title: 'Chapter one' },
      { start: 3, end: 4, title: 'Chapter two' },
    ]);
  });

  it('derives practical editor parts from level-two poem headings', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      [
        '# Book',
        '',
        'Introduction.',
        '',
        'More introduction.',
        '',
        '## Poem one',
        '',
        'First.  ',
        'Second.',
        '',
        '## Poem two',
        '',
        'Third.  ',
        'Fourth.',
      ].join('\n'),
      document,
    );

    expect(createPracticalContentPartState(document)).toEqual({
      starts: [0, 3, 5],
      activeIndex: 0,
    });
  });

  it('merges automatically derived parts that contain fewer than three visible blocks', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      [
        '# Substantial',
        '',
        'First.',
        '',
        'Second.',
        '',
        '# Tiny',
        '',
        'Only one line.',
        '',
        '# Next',
        '',
        'Third.',
        '',
        'Fourth.',
      ].join('\n'),
      document,
    );

    expect(createPracticalContentPartState(document)).toEqual({
      starts: [0, 5],
      activeIndex: 0,
    });
  });

  it('saves one part into the semantic model and shifts later boundaries', () => {
    const document = model();
    document.metadata.title = {
      value: 'Persistent title',
      provenance: {
        source: 'test',
        method: 'user',
        confidence: 'certain',
      },
    };
    document.blocks = markdownToBlocks(
      ['# One', '', 'Original.', '', '# Two', '', 'Keep me.'].join('\n'),
      document,
    );
    const state = createContentPartState(document);

    const saved = saveContentPart(
      document,
      state,
      ['# One', '', 'Revised.', '', 'Another paragraph.'].join('\n'),
    );

    expect({
      starts: saved.state.starts,
      blocks: saved.model.blocks,
      metadata: saved.model.metadata,
      assets: saved.model.assets,
    }).toMatchObject({
      starts: [0, 3],
      blocks: [
        { type: 'heading', children: [{ text: 'One' }] },
        { type: 'paragraph', children: [{ text: 'Revised.' }] },
        { type: 'paragraph', children: [{ text: 'Another paragraph.' }] },
        { type: 'heading', children: [{ text: 'Two' }] },
        { type: 'paragraph', children: [{ text: 'Keep me.' }] },
      ],
      metadata: document.metadata,
      assets: document.assets,
    });
  });

  it('saves Markdown line breaks within the same paragraph', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      '# One\n\nOriginal.\n\nMore text.',
      document,
    );

    const saved = saveContentPart(
      document,
      createContentPartState(document),
      '# One\n\nFirst line.  \nSecond line.\n\nMore text.',
    );

    expect(saved.model.blocks).toMatchObject([
      { type: 'heading', children: [{ text: 'One' }] },
      {
        type: 'paragraph',
        children: [
          { text: 'First line.' },
          { type: 'lineBreak' },
          { text: 'Second line.' },
        ],
      },
      { type: 'paragraph', children: [{ text: 'More text.' }] },
    ]);
  });

  it('preserves trailing spaces and newlines inside fenced code blocks', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      '# One\n\nOriginal.\n\nMore text.',
      document,
    );

    const saved = saveContentPart(
      document,
      createContentPartState(document),
      ['# One', '', '```txt', 'line  ', 'next', '```', '', 'More text.'].join(
        '\n',
      ),
    );

    expect(saved.model.blocks).toMatchObject([
      { type: 'heading' },
      { type: 'codeBlock', text: 'line  \nnext' },
      { type: 'paragraph', children: [{ text: 'More text.' }] },
    ]);
  });

  it('preserves page breaks without showing their Markdown marker or adjacent OCR stars', () => {
    const document = model();

    const blocks = markdownToBlocks(
      [
        '*Sam Hamill*',
        '',
        '\\*\\*',
        '',
        '<!-- markdown:page-break -->',
        '',
        'Next page.',
      ].join('\n'),
      document,
    );

    expect(blocks).toMatchObject([
      {
        type: 'paragraph',
        children: [{ text: 'Sam Hamill', marks: [{ type: 'italic' }] }],
      },
      { type: 'pageBreak' },
      { type: 'paragraph', children: [{ text: 'Next page.' }] },
    ]);
  });

  it('shows internal page breaks but omits a break at the end of a part', () => {
    const document = model();
    document.blocks = [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Before the image.' }],
      },
      { type: 'pageBreak' },
      {
        type: 'imageBlock',
        assetId: 'diagram',
        alt: 'Diagram',
      },
      { type: 'pageBreak' },
    ];

    const source = contentEditorSource(document);

    expect(source).toContain(
      'Before the image.\n\n<!-- markdown:page-break -->\n\n![Diagram]',
    );
    expect(source.match(/<!-- markdown:page-break -->/g)).toHaveLength(1);
    expect(source.trimEnd().endsWith('<!-- markdown:page-break -->')).toBe(
      false,
    );
    expect(
      saveContentPart(document, createContentPartState(document), source).model
        .blocks,
    ).toEqual(document.blocks);
  });

  it('merges only adjacent part boundaries without changing document content', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      ['# One', '', 'First.', '', '# Two', '', 'Second.'].join('\n'),
      document,
    );
    const state = createContentPartState(document);

    const merged = mergeContentPart(document, state, 'next');

    expect(merged).toEqual({
      model: document,
      state: { starts: [0], activeIndex: 0 },
    });
  });

  it('deletes the active part and activates the nearest remaining part', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      [
        '# One',
        '',
        'First.',
        '',
        '# Two',
        '',
        'Second.',
        '',
        '# Three',
        '',
        'Third.',
      ].join('\n'),
      document,
    );
    const state = {
      ...createContentPartState(document),
      activeIndex: 1,
    };

    const deleted = deleteContentPart(document, state);

    expect(deleted).toMatchObject({
      state: { starts: [0, 2], activeIndex: 1 },
      model: {
        blocks: [
          { type: 'heading', children: [{ text: 'One' }] },
          { type: 'paragraph', children: [{ text: 'First.' }] },
          { type: 'heading', children: [{ text: 'Three' }] },
          { type: 'paragraph', children: [{ text: 'Third.' }] },
        ],
      },
    });
  });

  it('splits before a selected level-two heading and activates the new part', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      [
        '# One',
        '',
        'Opening.',
        '',
        'Context.',
        '',
        '## Section',
        '',
        'Details.',
        '',
        'More details.',
      ].join('\n'),
      document,
    );
    const state = createContentPartState(document);

    const split = splitContentPart(document, state, 3);

    expect(split).toEqual({
      model: document,
      state: { starts: [0, 3], activeIndex: 1 },
    });
  });

  it('rejects a split that would create a two-block part', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      '# One\n\nOpening.\n\n## Tiny\n\nDetails.',
      document,
    );

    expect(
      splitContentPart(document, createContentPartState(document), 2),
    ).toBeUndefined();
  });

  it('offers only non-leading level-two headings as split points', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      [
        '## Existing boundary',
        '',
        'Opening.',
        '',
        'Context.',
        '',
        '### Detail',
        '',
        '## New part',
        '',
        'Details.',
        '',
        'More details.',
      ].join('\n'),
      document,
    );

    expect(
      contentPartSplitHeadings(document, createContentPartState(document)),
    ).toEqual([{ blockOffset: 4, title: 'New part' }]);
  });

  it('creates a current-part model without changing book-level data', () => {
    const document = model();
    document.blocks = markdownToBlocks(
      ['# One', '', 'First.', '', '# Two', '', 'Second.'].join('\n'),
      document,
    );
    const state = {
      ...createContentPartState(document),
      activeIndex: 1,
    };

    const part = contentPartModel(document, state);

    expect({
      blocks: part.blocks,
      metadata: part.metadata,
      assets: part.assets,
      equations: part.equations,
      notes: part.notes,
    }).toMatchObject({
      blocks: [
        { type: 'heading', children: [{ text: 'Two' }] },
        { type: 'paragraph', children: [{ text: 'Second.' }] },
      ],
      metadata: document.metadata,
      assets: document.assets,
      equations: document.equations,
      notes: document.notes,
    });
  });

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

  it('rejects editor images that are not backed by book assets', () => {
    const document = model();

    expect(
      unsupportedContentImageSources(
        [
          '![Stored](data:image/png;base64,AQID)',
          '![Remote](https://example.com/image.png)',
        ].join('\n\n'),
        document,
      ),
    ).toEqual(['https://example.com/image.png']);
  });

  it('imports newly inserted base64 images into the document model', () => {
    const document = model();
    const source =
      '![Pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==)';

    const imported = importContentDataImages(source, document);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.model.assets['editor-image-0001']).toMatchObject({
      id: 'editor-image-0001',
      mediaType: 'image/png',
      filename: 'editor-image-0001.png',
    });
    expect(imported.model.assets['editor-image-0001']?.data).toHaveLength(67);
    expect(unsupportedContentImageSources(source, imported.model)).toEqual([]);
    expect(markdownToBlocks(source, imported.model)).toMatchObject([
      {
        type: 'paragraph',
        children: [{ type: 'image', assetId: 'editor-image-0001' }],
      },
    ]);
  });

  it('imports base64 images inserted inside Markdown table cells', () => {
    const document = model();
    const source = [
      '| Image |',
      '| --- |',
      '| ![Pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==) |',
    ].join('\n');

    const imported = importContentDataImages(source, document);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.model.assets['editor-image-0001']).toMatchObject({
      mediaType: 'image/png',
    });
    expect(markdownToBlocks(source, imported.model)).toMatchObject([
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Image' }],
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
                    children: [{ type: 'image', assetId: 'editor-image-0001' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('rejects inserted base64 data that is not the declared image type', () => {
    const imported = importContentDataImages(
      '![Not an image](data:image/png;base64,SGVsbG8=)',
      model(),
    );

    expect(imported).toMatchObject({
      ok: false,
      reason: 'invalid-image',
    });
  });

  it('bounds newly inserted base64 image data before decoding it', () => {
    const imported = importContentDataImages(
      '![Pixel](data:image/png;base64,iVBORw0KGgo=)',
      model(),
      { maxImages: 1, maxImageBytes: 4, maxTotalBytes: 8 },
    );

    expect(imported).toMatchObject({
      ok: false,
      reason: 'image-too-large',
    });
  });

  it('does not consume body text when an image caption is deleted', () => {
    const document = model();
    document.blocks = [
      {
        type: 'imageBlock',
        assetId: 'diagram',
        caption: [{ type: 'text', text: 'Original caption' }],
      },
      { type: 'paragraph', children: [{ type: 'text', text: 'Body text' }] },
    ];

    const saved = saveContentPart(
      document,
      createContentPartState(document),
      '![Diagram](data:image/png;base64,AQID)\n\nBody *text*',
    );

    expect(saved.model.blocks[0]).toEqual({
      type: 'imageBlock',
      assetId: 'diagram',
      alt: 'Diagram',
    });
    expect(saved.model.blocks[1]).toMatchObject({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'Body ' },
        { type: 'text', text: 'text', marks: [{ type: 'italic' }] },
      ],
    });
  });

  it('does not consume body text when a table caption is deleted', () => {
    const document = model();
    document.blocks = [
      {
        type: 'table',
        caption: [{ type: 'text', text: 'Original caption' }],
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Old value' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const saved = saveContentPart(
      document,
      createContentPartState(document),
      'Read the *important* table.\n\n| Value |\n| --- |\n| New value |',
    );

    expect(saved.model.blocks[0]).toMatchObject({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'Read the ' },
        { type: 'text', text: 'important', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' table.' },
      ],
    });
    expect(saved.model.blocks[1]?.type).toBe('table');
    expect(JSON.stringify(saved.model.blocks[1])).toContain('New value');
    expect(saved.model.blocks[1]).not.toHaveProperty('caption');
  });

  it('preserves document semantics while saving ordinary text edits', () => {
    const document = model();
    document.metadata.title = {
      value: 'Book title',
      provenance: {
        source: 'test',
        method: 'user',
        confidence: 'certain',
      },
    };
    document.blocks = [
      {
        type: 'heading',
        level: 1,
        id: 'chapter-one',
        numbering: '1',
        styleId: 'Heading1',
        children: [{ type: 'text', text: 'Chapter one' }],
      },
      {
        type: 'paragraph',
        styleId: 'Body',
        children: [{ type: 'text', text: 'Original copy.' }],
      },
      ...(
        [
          'bold',
          'italic',
          'underline',
          'strikethrough',
          'subscript',
          'superscript',
          'code',
        ] as const
      ).map((type) => ({
        type: 'paragraph' as const,
        children: [
          {
            type: 'text' as const,
            text: `${type} text`,
            marks: [{ type }],
          },
        ],
      })),
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Before ' },
          {
            type: 'text',
            text: 'custom style',
            marks: [{ type: 'style', styleId: 'Emphasis' }],
          },
          { type: 'text', text: ' after' },
        ],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'equation', equationId: 'inline-equation' },
          { type: 'noteReference', noteId: 'note-1' },
          {
            type: 'image',
            assetId: 'diagram',
            alt: 'Equation image',
            presentation: 'equation',
            width: 0.45,
          },
        ],
      },
      { type: 'pageBreak' },
      {
        type: 'imageBlock',
        assetId: 'diagram',
        alt: 'Diagram',
        caption: [{ type: 'text', text: 'Figure one' }],
      },
      { type: 'equationBlock', equationId: 'block-equation' },
      {
        type: 'table',
        caption: [{ type: 'text', text: 'Results' }],
        rows: [
          {
            cells: [
              {
                colSpan: 2,
                rowSpan: 2,
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Cell' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    document.equations = {
      'inline-equation': {
        id: 'inline-equation',
        source: { format: 'tex', value: 'x + y' },
        tex: 'x + y',
        conversionComplete: true,
        display: 'inline',
      },
      'block-equation': {
        id: 'block-equation',
        source: { format: 'tex', value: 'z = 2' },
        tex: 'z = 2',
        conversionComplete: true,
        display: 'block',
      },
    };
    document.notes = {
      'note-1': {
        id: 'note-1',
        kind: 'footnote',
        blocks: [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: 'Keep this note.' }],
          },
        ],
      },
    };
    const state = createContentPartState(document);
    const source = contentEditorSource(contentPartModel(document, state));

    expect(source).not.toContain('# Book title');
    const saved = saveContentPart(
      document,
      state,
      source.replace('Original copy.', 'Revised copy.'),
    );

    expect(saved.model.blocks).toEqual([
      document.blocks[0],
      {
        ...document.blocks[1],
        children: [{ type: 'text', text: 'Revised copy.' }],
      },
      ...document.blocks.slice(2),
    ]);
    expect(saved.model.equations).toBe(document.equations);
    expect(saved.model.notes).toBe(document.notes);
  });

  it('keeps semantic identity on existing blocks when content is inserted before them', () => {
    const document = model();
    document.blocks = [
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'text', text: 'Chapter' }],
      },
      {
        type: 'heading',
        level: 2,
        id: 'original-section',
        styleId: 'Heading2',
        children: [{ type: 'text', text: 'Original section' }],
      },
      {
        type: 'paragraph',
        styleId: 'Body',
        children: [{ type: 'text', text: 'Styled paragraph.' }],
      },
    ];
    const state = createContentPartState(document);
    const source = contentEditorSource(document)
      .replace(
        '<a id="original-section"></a>\n## Original section',
        '## New section\n\n<a id="original-section"></a>\n## Original section',
      )
      .replace('Styled paragraph.', 'Inserted paragraph.\n\nStyled paragraph.');

    const saved = saveContentPart(document, state, source);

    expect(saved.model.blocks).toMatchObject([
      { type: 'heading', level: 1, children: [{ text: 'Chapter' }] },
      {
        type: 'heading',
        level: 2,
        children: [{ text: 'New section' }],
      },
      {
        type: 'heading',
        level: 2,
        id: 'original-section',
        styleId: 'Heading2',
        children: [{ text: 'Original section' }],
      },
      {
        type: 'paragraph',
        children: [{ text: 'Inserted paragraph.' }],
      },
      {
        type: 'paragraph',
        styleId: 'Body',
        children: [{ text: 'Styled paragraph.' }],
      },
    ]);
    expect(saved.model.blocks[1]).not.toHaveProperty('id');
    expect(saved.model.blocks[3]).not.toHaveProperty('styleId');
  });

  it('uses heading anchors to disambiguate identical inserted headings', () => {
    const document = model();
    document.blocks = [
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'text', text: 'Chapter' }],
      },
      {
        type: 'heading',
        level: 2,
        id: 'target',
        styleId: 'Heading2',
        children: [{ type: 'text', text: 'Same' }],
      },
    ];
    const state = createContentPartState(document);
    const source = contentEditorSource(document).replace(
      '<a id="target"></a>\n## Same',
      '## Same\n\n<a id="target"></a>\n## Same',
    );

    const saved = saveContentPart(document, state, source);

    expect(saved.model.blocks).toMatchObject([
      { type: 'heading', level: 1, children: [{ text: 'Chapter' }] },
      { type: 'heading', level: 2, children: [{ text: 'Same' }] },
      {
        type: 'heading',
        level: 2,
        id: 'target',
        styleId: 'Heading2',
        children: [{ text: 'Same' }],
      },
    ]);
    expect(saved.model.blocks[1]).not.toHaveProperty('id');
  });

  it('keeps distinct equation references with identical source text', () => {
    const document = model();
    document.equations = {
      first: {
        id: 'first',
        source: { format: 'tex', value: 'x' },
        tex: 'x',
        conversionComplete: true,
      },
      second: {
        id: 'second',
        source: { format: 'tex', value: 'x' },
        tex: 'x',
        conversionComplete: true,
      },
    };
    document.blocks = [
      {
        type: 'paragraph',
        children: [
          { type: 'equation', equationId: 'first' },
          { type: 'text', text: ' and ' },
          { type: 'equation', equationId: 'second' },
        ],
      },
      { type: 'equationBlock', equationId: 'second' },
    ];
    const state = createContentPartState(document);

    const saved = saveContentPart(
      document,
      state,
      contentEditorSource(document),
    );

    expect(saved.model.blocks).toEqual(document.blocks);
  });

  it('keeps stable equation references after surrounding text is inserted', () => {
    const document = model();
    document.equations = {
      first: {
        id: 'first',
        source: { format: 'tex', value: String.raw`price = \$5` },
        tex: String.raw`price = \$5`,
        conversionComplete: true,
      },
      second: {
        id: 'second',
        source: { format: 'tex', value: String.raw`price = \$5` },
        tex: String.raw`price = \$5`,
        conversionComplete: true,
      },
    };
    document.blocks = [
      {
        type: 'paragraph',
        children: [
          { type: 'equation', equationId: 'first' },
          { type: 'text', text: ' then ' },
          { type: 'equation', equationId: 'second' },
        ],
      },
    ];
    const source = contentEditorSource(document).replace(
      '<span data-wordconvert-equation-id="second"',
      'inserted <span data-wordconvert-equation-id="second"',
    );

    const saved = saveContentPart(
      document,
      createContentPartState(document),
      source,
    );

    expect(saved.model.blocks).toMatchObject([
      {
        type: 'paragraph',
        children: [
          { type: 'equation', equationId: 'first' },
          { type: 'text', text: ' then inserted ' },
          { type: 'equation', equationId: 'second' },
        ],
      },
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
