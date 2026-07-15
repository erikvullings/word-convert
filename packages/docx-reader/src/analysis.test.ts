import { describe, expect, it } from 'vitest';

import {
  analyseStyles,
  applyStyleMappings,
  resolveMetadataCandidates,
  type RawStyle,
  type StyleUsage,
} from './analysis.ts';

const usages: StyleUsage[] = [
  {
    styleId: 'Body',
    kind: 'paragraph',
    text: 'A long body paragraph used repeatedly.',
    position: 3,
  },
  {
    styleId: 'Inherited',
    kind: 'paragraph',
    text: 'Inherited section',
    position: 2,
  },
  {
    styleId: 'Body',
    kind: 'paragraph',
    text: 'Another ordinary body paragraph.',
    position: 1,
  },
];

describe('style analysis', () => {
  it('computes inherited effective formatting and usage for every used style from unsorted input', () => {
    const styles: RawStyle[] = [
      {
        id: 'Inherited',
        name: 'Project section',
        kind: 'paragraph',
        basedOn: 'Heading1',
        formatting: { italic: true },
      },
      {
        id: 'Body',
        name: 'Normal',
        kind: 'paragraph',
        formatting: { fontFamily: 'Aptos', fontSizePt: 11 },
      },
      {
        id: 'Heading1',
        name: 'heading 1',
        kind: 'paragraph',
        basedOn: 'Body',
        formatting: { bold: true, outlineLevel: 0, spacingBeforePt: 12 },
      },
    ];

    const result = analyseStyles(styles, usages);

    expect(result.map(({ id }) => id)).toEqual(['Body', 'Inherited']);
    expect(result[1]).toMatchObject({
      formatting: {
        fontFamily: 'Aptos',
        fontSizePt: 11,
        bold: true,
        italic: true,
        outlineLevel: 0,
        spacingBeforePt: 12,
      },
      usageCount: 1,
      examples: ['Inherited section'],
      proposedMapping: 'heading1',
      reasons: [
        'OOXML outline level takes precedence over style identifiers and names.',
      ],
    });
    expect(result[1]?.provenance.reason).toContain('OOXML outline level');
  });

  it('uses exact precedence and lets an explicit mapping override outline and built-in evidence', () => {
    const result = analyseStyles(
      [
        {
          id: 'Heading1',
          name: 'heading 1',
          kind: 'paragraph',
          formatting: { outlineLevel: 0 },
        },
      ],
      [
        {
          styleId: 'Heading1',
          kind: 'paragraph',
          text: 'Not a heading',
          position: 0,
        },
      ],
      { mappings: { Heading1: 'blockquote' } },
    );
    expect(result[0]).toMatchObject({
      proposedMapping: 'blockquote',
      provenance: { confidence: 'certain', method: 'user' },
    });
    expect(result[0]?.provenance.reason).toContain('Explicit user mapping');
  });

  it('treats localized aliases as fallback evidence and does not infer a heading from font size alone', () => {
    const result = analyseStyles(
      [
        {
          id: 'Zitat',
          name: 'Zitat',
          kind: 'paragraph',
          formatting: { fontSizePt: 18 },
        },
        {
          id: 'LargeOnly',
          name: 'Display',
          kind: 'paragraph',
          formatting: { fontSizePt: 28 },
        },
      ],
      [
        {
          styleId: 'LargeOnly',
          kind: 'paragraph',
          text: 'Large pull quote',
          position: 1,
        },
        { styleId: 'Zitat', kind: 'paragraph', text: 'Ein Zitat', position: 0 },
      ],
    );
    expect(result.find(({ id }) => id === 'Zitat')?.proposedMapping).toBe(
      'blockquote',
    );
    expect(result.find(({ id }) => id === 'LargeOnly')?.proposedMapping).toBe(
      'body',
    );
  });

  it('recognises compound Dutch and English caption styles from names and nearby content', () => {
    const result = analyseStyles(
      [
        {
          id: 'BijschriftFoto',
          name: 'BijschriftFoto',
          kind: 'paragraph',
          formatting: { italic: true },
        },
        {
          id: 'CaptionLabel',
          name: 'CaptionLabel',
          kind: 'character',
          formatting: {},
        },
        {
          id: 'CustomTableText',
          name: 'Small text',
          kind: 'paragraph',
          formatting: {},
        },
      ],
      [
        {
          styleId: 'CustomTableText',
          kind: 'paragraph',
          text: 'Table 2. Results',
          position: 8,
          nearbyContent: 'table',
        },
        {
          styleId: 'CaptionLabel',
          kind: 'character',
          text: 'Fig.',
          position: 3,
        },
        {
          styleId: 'BijschriftFoto',
          kind: 'paragraph',
          text: 'Afbeelding 1. Locatie',
          position: 2,
          nearbyContent: 'figure',
        },
      ],
    );

    expect(
      result.map(({ id, proposedMapping }) => [id, proposedMapping]),
    ).toEqual([
      ['BijschriftFoto', 'caption'],
      ['CaptionLabel', 'caption'],
      ['CustomTableText', 'caption'],
    ]);
  });

  it('recognises a unique largest display style near the document start as the title', () => {
    const result = analyseStyles(
      [
        {
          id: 'RapportTitel',
          name: '**RapportTitel',
          kind: 'paragraph',
          formatting: { fontSizePt: 44 },
        },
        {
          id: 'Body',
          name: 'Normal',
          kind: 'paragraph',
          formatting: { fontSizePt: 11 },
        },
      ],
      [
        {
          styleId: 'Body',
          kind: 'paragraph',
          text: 'Body text',
          position: 9,
        },
        {
          styleId: 'RapportTitel',
          kind: 'paragraph',
          text: 'Annual security report',
          position: 0,
        },
      ],
    );

    expect(result.find(({ id }) => id === 'RapportTitel')).toMatchObject({
      proposedMapping: 'title',
      provenance: { confidence: 'high' },
    });
  });

  it('applies presets deterministically and explicit mappings override preset entries', () => {
    const raw: RawStyle[] = [
      { id: 'Section', kind: 'paragraph', formatting: {} },
    ];
    const usage: StyleUsage[] = [
      { styleId: 'Section', kind: 'paragraph', text: 'Section', position: 0 },
    ];
    const first = analyseStyles(raw, usage, {
      preset: { Section: 'heading2' },
      mappings: { Section: 'heading3' },
    });
    const second = analyseStyles(raw, usage, {
      preset: { Section: 'heading2' },
      mappings: { Section: 'heading3' },
    });
    expect(first).toEqual(second);
    expect(first[0]?.proposedMapping).toBe('heading3');
  });
});

describe('metadata analysis and final construction', () => {
  it('resolves source priority while preserving structured authors, provenance, and distinct dates', () => {
    const metadata = resolveMetadataCandidates(
      [
        {
          field: 'title',
          value: 'Filename title',
          source: 'filename',
          priority: 7,
          confidence: 'low',
          method: 'inferred',
        },
        {
          field: 'title',
          value: 'Core title',
          source: 'docProps/core.xml',
          priority: 1,
          confidence: 'certain',
          method: 'extracted',
        },
        {
          field: 'authors',
          value: { name: 'Ada Example' },
          source: 'docProps/core.xml',
          priority: 1,
          confidence: 'certain',
          method: 'extracted',
        },
        {
          field: 'authors',
          value: { name: 'Grace Example', role: 'editor' },
          source: 'Author style',
          priority: 4,
          confidence: 'high',
          method: 'inferred',
        },
        {
          field: 'sourceCreatedAt',
          value: '2024-01-01',
          source: 'docProps/core.xml',
          priority: 1,
          confidence: 'certain',
          method: 'extracted',
        },
        {
          field: 'sourceModifiedAt',
          value: '2024-02-01',
          source: 'docProps/core.xml',
          priority: 1,
          confidence: 'certain',
          method: 'extracted',
        },
        {
          field: 'publicationDate',
          value: '2024-03-01',
          source: 'custom:PublicationDate',
          priority: 3,
          confidence: 'high',
          method: 'extracted',
        },
      ],
      '2026-07-15',
    );
    expect(metadata.title?.value).toBe('Core title');
    expect(metadata.title?.provenance.source).toBe('docProps/core.xml');
    expect(metadata.authors.map(({ value }) => value)).toEqual([
      { name: 'Ada Example' },
      { name: 'Grace Example', role: 'editor' },
    ]);
    expect([
      metadata.sourceCreatedAt?.value,
      metadata.sourceModifiedAt?.value,
      metadata.publicationDate?.value,
      metadata.conversionDate.value,
    ]).toEqual(['2024-01-01', '2024-02-01', '2024-03-01', '2026-07-15']);
  });

  it('defaults low-confidence publication dates to conversion date with explicit default provenance', () => {
    const metadata = resolveMetadataCandidates(
      [
        {
          field: 'publicationDate',
          value: '1999',
          source: 'cover inference',
          priority: 6,
          confidence: 'low',
          method: 'inferred',
        },
      ],
      '2026-07-15',
    );
    expect(metadata.publicationDate).toMatchObject({
      value: '2026-07-15',
      provenance: { method: 'default', confidence: 'certain' },
    });
  });

  it('reserves level one for the title and shifts document headings down', () => {
    const model = {
      blocks: [
        {
          type: 'paragraph' as const,
          styleId: 'Title',
          children: [{ type: 'text' as const, text: 'Document' }],
        },
        {
          type: 'paragraph' as const,
          styleId: 'Section',
          children: [{ type: 'text' as const, text: 'Section' }],
        },
        {
          type: 'paragraph' as const,
          styleId: 'Deep',
          children: [{ type: 'text' as const, text: 'Deep section' }],
        },
      ],
    };
    expect(
      applyStyleMappings(model.blocks, {
        Title: 'title',
        Section: 'heading2',
        Deep: 'heading6',
      }),
    ).toEqual([
      {
        type: 'heading',
        level: 1,
        styleId: 'Title',
        children: [{ type: 'text', text: 'Document' }],
      },
      {
        type: 'heading',
        level: 3,
        styleId: 'Section',
        children: [{ type: 'text', text: 'Section' }],
      },
      {
        type: 'heading',
        level: 6,
        styleId: 'Deep',
        children: [{ type: 'text', text: 'Deep section' }],
      },
    ]);
  });
});
