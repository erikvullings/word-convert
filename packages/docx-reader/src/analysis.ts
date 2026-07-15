import {
  type AnalysedStyle,
  type BlockNode,
  type Confidence,
  type DocumentMetadata,
  type EffectiveFormatting,
  type InferredValue,
  type Person,
  type Provenance,
  type StyleMapping,
} from '@wordconvert/document-model';

export interface RawStyle {
  id: string;
  name?: string;
  kind: 'paragraph' | 'character';
  basedOn?: string;
  formatting: EffectiveFormatting;
  default?: boolean;
  tableOfContentsLevel?: number;
}

export interface StyleUsage {
  styleId: string;
  kind: 'paragraph' | 'character';
  text: string;
  position: number;
  formatting?: EffectiveFormatting;
  numbered?: boolean;
  nearbyContent?: 'figure' | 'table';
}

export interface StyleAnalysisOptions {
  preset?: Readonly<Record<string, StyleMapping>>;
  mappings?: Readonly<Record<string, StyleMapping>>;
}

export type MetadataField =
  | 'title'
  | 'subtitle'
  | 'authors'
  | 'language'
  | 'publisher'
  | 'description'
  | 'subjects'
  | 'version'
  | 'sourceCreatedAt'
  | 'sourceModifiedAt'
  | 'publicationDate'
  | 'identifier'
  | 'rights';

export interface MetadataCandidate {
  field: MetadataField;
  value: string | Person;
  source: string;
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  confidence: Confidence;
  method: Provenance['method'];
  location?: string;
  reason?: string;
}

const normalise = (value: string): string =>
  value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();

const aliases: Readonly<
  Record<'title' | 'subtitle' | 'caption' | 'blockquote', readonly string[]>
> = {
  title: [
    'title',
    'titel',
    'titre',
    'titulo',
    'titolo',
    'tytul',
    'naslov',
    'nadpis',
    'cim',
    'titlu',
    'baslik',
    'teideal',
    'virsraksts',
    'pavadinimas',
    'otsikko',
    'rubrik',
    'titill',
    'tiotal',
    'titull',
    'titulli',
  ],
  subtitle: [
    'subtitle',
    'untertitel',
    'sous titre',
    'subtitulo',
    'sottotitolo',
    'podtytul',
    'podnaslov',
    'podnadpis',
    'subtitlu',
    'alt baslik',
    'alaotsikko',
    'underrubrik',
  ],
  caption: [
    'caption',
    'bijschrift',
    'legende',
    'leyenda',
    'didascalia',
    'podpis',
    'popisek',
    'billedtekst',
    'kuvateksti',
    'bildtext',
    'felirat',
    'legenda',
  ],
  blockquote: [
    'quote',
    'quotation',
    'blockquote',
    'zitat',
    'citat',
    'citation',
    'citazione',
    'citacao',
    'cytat',
    'citace',
    'citaat',
    'lainaus',
    'citatet',
    'citatul',
  ],
};

function mergeFormatting(
  parent: EffectiveFormatting,
  own: EffectiveFormatting,
): EffectiveFormatting {
  return { ...parent, ...own };
}

function effectiveFormatting(
  style: RawStyle,
  byId: ReadonlyMap<string, RawStyle>,
  visiting = new Set<string>(),
): EffectiveFormatting {
  if (!style.basedOn || visiting.has(style.id)) return { ...style.formatting };
  const parent = byId.get(style.basedOn);
  if (!parent) return { ...style.formatting };
  const next = new Set(visiting);
  next.add(style.id);
  return mergeFormatting(
    effectiveFormatting(parent, byId, next),
    style.formatting,
  );
}

function headingMapping(level: number): StyleMapping {
  const bounded = Math.min(6, Math.max(1, level));
  return `heading${bounded}` as StyleMapping;
}

function proposal(
  style: RawStyle,
  formatting: EffectiveFormatting,
  usage: readonly StyleUsage[],
  options: StyleAnalysisOptions,
  largestParagraphFontSizePt?: number,
): { mapping: StyleMapping; provenance: Provenance } {
  const explicit = options.mappings?.[style.id];
  if (explicit)
    return {
      mapping: explicit,
      provenance: {
        source: 'user-mappings',
        method: 'user',
        confidence: 'certain',
        reason: 'Explicit user mapping has highest precedence.',
      },
    };
  const preset = options.preset?.[style.id];
  if (preset)
    return {
      mapping: preset,
      provenance: {
        source: 'mapping-preset',
        method: 'user',
        confidence: 'certain',
        reason:
          'Mapping preset applied deterministically before inferred evidence.',
      },
    };
  if (
    formatting.outlineLevel !== undefined &&
    formatting.outlineLevel >= 0 &&
    formatting.outlineLevel <= 5
  )
    return {
      mapping: headingMapping(formatting.outlineLevel + 1),
      provenance: {
        source: 'word/styles.xml',
        method: 'inferred',
        confidence: 'certain',
        reason:
          'OOXML outline level takes precedence over style identifiers and names.',
      },
    };
  const builtIn = /^(?:heading|headingchar)([1-6])$/i.exec(style.id);
  if (builtIn?.[1])
    return {
      mapping: headingMapping(Number(builtIn[1])),
      provenance: {
        source: 'style-id',
        method: 'inferred',
        confidence: 'high',
        reason: 'Built-in Word style ID identifies a heading.',
      },
    };
  if (style.tableOfContentsLevel !== undefined)
    return {
      mapping: headingMapping(style.tableOfContentsLevel + 1),
      provenance: {
        source: 'table-of-contents',
        method: 'inferred',
        confidence: 'high',
        reason: 'Table-of-contents relationship identifies a heading level.',
      },
    };
  const name = normalise(style.name ?? '');
  const localizedHeading =
    /(?:heading|kop|uberschrift|titre|titulo|titolo|naglowek|rubrik|nadpis|otsikko|naslov|cim|fejezet|cabecera|virsraksts|pavadinimas)[ ]*([1-6])/.exec(
      name,
    );
  if (localizedHeading?.[1])
    return {
      mapping: headingMapping(Number(localizedHeading[1])),
      provenance: {
        source: 'localized-style-aliases',
        method: 'inferred',
        confidence: 'medium',
        reason: 'Localized style-name alias used as fallback evidence.',
      },
    };
  const short =
    usage.length > 0 && usage.every(({ text }) => text.trim().length <= 100);
  const fontSizes = usage
    .map(({ formatting: direct }) => direct?.fontSizePt ?? formatting.fontSizePt)
    .filter((size): size is number => size !== undefined);
  const fontSizePt = fontSizes.length > 0 ? Math.max(...fontSizes) : undefined;
  if (
    style.kind === 'paragraph' &&
    usage.length === 1 &&
    usage[0]!.position <= 2 &&
    short &&
    fontSizePt !== undefined &&
    fontSizePt >= 32 &&
    fontSizePt === largestParagraphFontSizePt
  )
    return {
      mapping: 'title',
      provenance: {
        source: 'typographic-structural-analysis',
        method: 'inferred',
        confidence: 'high',
        reason:
          'A unique, short paragraph near the document start uses the document’s largest display-size text.',
      },
    };
  const compactName = name.replaceAll(' ', '');
  const captionName = aliases.caption.some((alias) =>
    compactName.includes(normalise(alias).replaceAll(' ', '')),
  );
  const captionText = usage.some(({ text }) =>
    /^(?:figure|fig|photo|image|table|figuur|afbeelding|foto|tabel)\b/.test(
      normalise(text),
    ),
  );
  const captionNeighbour = usage.some(
    ({ nearbyContent }) => nearbyContent !== undefined,
  );
  if (
    captionName ||
    captionText ||
    (style.kind === 'paragraph' && captionNeighbour)
  )
    return {
      mapping: 'caption',
      provenance: {
        source: 'caption-context-analysis',
        method: 'inferred',
        confidence: captionNeighbour || captionName ? 'high' : 'medium',
        reason: captionName
          ? 'The style name contains a localized caption alias.'
          : captionNeighbour
            ? 'The paragraph is adjacent to a figure or table.'
            : 'The paragraph text begins with a figure or table label.',
      },
    };
  for (const [mapping, names] of Object.entries(aliases) as Array<
    [keyof typeof aliases, readonly string[]]
  >) {
    if (names.includes(name))
      return {
        mapping,
        provenance: {
          source: 'localized-style-aliases',
          method: 'inferred',
          confidence: 'medium',
          reason: 'Localized style-name alias used as fallback evidence.',
        },
      };
  }
  if (style.basedOn) {
    const inherited = /^(?:heading|headingchar)([1-6])$/i.exec(style.basedOn);
    if (inherited?.[1])
      return {
        mapping: headingMapping(Number(inherited[1])),
        provenance: {
          source: 'style-inheritance',
          method: 'inferred',
          confidence: 'medium',
          reason: 'Style inherits from a built-in heading style.',
        },
      };
  }
  const bold =
    formatting.bold === true ||
    (usage.length > 0 &&
      usage.every(({ formatting: direct }) => direct?.bold === true));
  const spaced =
    (formatting.spacingBeforePt ?? 0) > 0 ||
    (usage.length > 0 &&
      usage.every(
        ({ formatting: direct }) => (direct?.spacingBeforePt ?? 0) > 0,
      ));
  const numbered = usage.some(({ numbered: value }) => value === true);
  if (short && bold && (spaced || numbered))
    return {
      mapping: 'heading1',
      provenance: {
        source: 'typographic-structural-analysis',
        method: 'inferred',
        confidence: 'low',
        reason:
          'Combined short text, boldness, and spacing or numbering suggest a heading; font size was not used alone.',
      },
    };
  return {
    mapping: 'body',
    provenance: {
      source: 'plain-paragraph-fallback',
      method: 'inferred',
      confidence: 'medium',
      reason:
        'No higher-precedence structural evidence; plain paragraph fallback applied.',
    },
  };
}

export function analyseStyles(
  rawStyles: readonly RawStyle[],
  usages: readonly StyleUsage[],
  options: StyleAnalysisOptions = {},
): AnalysedStyle[] {
  const byId = new Map(rawStyles.map((style) => [style.id, style]));
  const usedIds = new Set(usages.map(({ styleId }) => styleId));
  const paragraphFontSizes = usages.flatMap((usage) => {
    if (usage.kind !== 'paragraph') return [];
    const style = byId.get(usage.styleId);
    const size =
      usage.formatting?.fontSizePt ??
      (style ? effectiveFormatting(style, byId).fontSizePt : undefined);
    return size === undefined ? [] : [size];
  });
  const largestParagraphFontSizePt =
    paragraphFontSizes.length > 0 ? Math.max(...paragraphFontSizes) : undefined;
  return rawStyles
    .filter(({ id }) => usedIds.has(id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((style) => {
      const styleUsages = usages
        .filter(
          ({ styleId, kind }) => styleId === style.id && kind === style.kind,
        )
        .sort((left, right) => left.position - right.position);
      const formatting = effectiveFormatting(style, byId);
      const proposed = proposal(
        style,
        formatting,
        styleUsages,
        options,
        largestParagraphFontSizePt,
      );
      return {
        id: style.id,
        ...(style.name ? { name: style.name } : {}),
        kind: style.kind,
        ...(style.basedOn ? { basedOn: style.basedOn } : {}),
        formatting,
        usageCount: styleUsages.length,
        examples: [
          ...new Set(
            styleUsages.map(({ text }) => text.trim()).filter(Boolean),
          ),
        ].slice(0, 3),
        proposedMapping: proposed.mapping,
        reasons: proposed.provenance.reason ? [proposed.provenance.reason] : [],
        provenance: proposed.provenance,
      };
    });
}

const candidateProvenance = (candidate: MetadataCandidate): Provenance => ({
  source: candidate.source,
  ...(candidate.location ? { location: candidate.location } : {}),
  method: candidate.method,
  confidence: candidate.confidence,
  ...(candidate.reason ? { reason: candidate.reason } : {}),
});

export function resolveMetadataCandidates(
  candidates: readonly MetadataCandidate[],
  conversionDate: string,
): DocumentMetadata {
  const ordered = [...candidates].sort(
    (left, right) => left.priority - right.priority,
  );
  const scalar = (
    field: Exclude<MetadataField, 'authors' | 'subjects'>,
  ): InferredValue<string> | undefined => {
    const candidate = ordered.find(
      (item) => item.field === field && typeof item.value === 'string',
    );
    return candidate && typeof candidate.value === 'string'
      ? { value: candidate.value, provenance: candidateProvenance(candidate) }
      : undefined;
  };
  const publication = ordered.find(
    (item) =>
      item.field === 'publicationDate' &&
      typeof item.value === 'string' &&
      (item.confidence === 'high' || item.confidence === 'certain'),
  );
  const authors = ordered.filter(
    (item): item is MetadataCandidate & { value: Person } =>
      item.field === 'authors' && typeof item.value !== 'string',
  );
  const subjects = ordered.filter(
    (item): item is MetadataCandidate & { value: string } =>
      item.field === 'subjects' && typeof item.value === 'string',
  );
  const result: DocumentMetadata = {
    authors: authors.map((candidate) => ({
      value: candidate.value,
      provenance: candidateProvenance(candidate),
    })),
    subjects: subjects.map((candidate) => ({
      value: candidate.value,
      provenance: candidateProvenance(candidate),
    })),
    conversionDate: {
      value: conversionDate,
      provenance: {
        source: 'conversion-options',
        method: 'user',
        confidence: 'certain',
      },
    },
    publicationDate:
      publication && typeof publication.value === 'string'
        ? {
            value: publication.value,
            provenance: candidateProvenance(publication),
          }
        : {
            value: conversionDate,
            provenance: {
              source: 'conversion-date',
              method: 'default',
              confidence: 'certain',
              reason: 'No high-confidence publication date was detected.',
            },
          },
  };
  for (const field of [
    'title',
    'subtitle',
    'language',
    'publisher',
    'description',
    'version',
    'sourceCreatedAt',
    'sourceModifiedAt',
    'identifier',
    'rights',
  ] as const) {
    const value = scalar(field);
    if (value) Object.assign(result, { [field]: value });
  }
  return result;
}

export function applyStyleMappings(
  blocks: readonly BlockNode[],
  mappings: Readonly<Record<string, StyleMapping>>,
): BlockNode[] {
  return blocks.flatMap((block): BlockNode[] => {
    const mapping =
      'styleId' in block && block.styleId ? mappings[block.styleId] : undefined;
    if (mapping === 'ignore') return [];
    if (
      mapping?.startsWith('heading') &&
      (block.type === 'paragraph' || block.type === 'heading')
    ) {
      return [
        {
          ...block,
          type: 'heading',
          level: Number(mapping.slice(7)) as 1 | 2 | 3 | 4 | 5 | 6,
        },
      ];
    }
    if (block.type === 'list')
      return [
        {
          ...block,
          items: block.items.map((item) => ({
            blocks: applyStyleMappings(item.blocks, mappings),
          })),
        },
      ];
    if (block.type === 'table')
      return [
        {
          ...block,
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              blocks: applyStyleMappings(cell.blocks, mappings),
            })),
          })),
        },
      ];
    if (block.type === 'blockquote')
      return [{ ...block, blocks: applyStyleMappings(block.blocks, mappings) }];
    return [block];
  });
}
