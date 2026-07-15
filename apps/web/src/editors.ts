import type {
  AnalysedStyle,
  Confidence,
  DocumentMetadata,
  InferredValue,
  Person,
  StyleMapping,
} from '@wordconvert/document-model';

export const STYLE_MAPPINGS = [
  'title',
  'subtitle',
  'author',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'body',
  'blockquote',
  'caption',
  'footnote',
  'code',
  'ignore',
] as const satisfies readonly StyleMapping[];

export type EditableMetadataField = Exclude<
  keyof DocumentMetadata,
  'authors' | 'subjects'
>;

export interface StylePresetImportResult {
  ok: boolean;
  mappings?: Record<string, StyleMapping>;
  error?: string;
}

const USER_PROVENANCE = {
  source: 'metadata editor',
  method: 'user',
  confidence: 'certain',
} as const;

export function acceptHighConfidenceMappings(
  styles: readonly AnalysedStyle[],
  current: Readonly<Record<string, StyleMapping>>,
): Record<string, StyleMapping> {
  const result = { ...current };
  for (const style of styles) {
    if (
      result[style.id] === undefined &&
      isHighConfidence(style.provenance.confidence)
    )
      result[style.id] = style.proposedMapping;
  }
  return result;
}

export function exportStylePreset(
  mappings: Readonly<Record<string, StyleMapping>>,
): string {
  return JSON.stringify(
    { schema: 'wordconvert.style-preset', version: 1, mappings },
    null,
    2,
  );
}

export function importStylePreset(json: string): StylePresetImportResult {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, error: 'The preset is not valid JSON.' };
  }
  if (!isPlainRecord(value))
    return { ok: false, error: 'The preset must be an object.' };
  if (
    value.schema !== 'wordconvert.style-preset' ||
    value.version !== 1 ||
    !isPlainRecord(value.mappings)
  )
    return { ok: false, error: 'The preset schema or version is unsupported.' };

  const mappings: Record<string, StyleMapping> = Object.create(null) as Record<
    string,
    StyleMapping
  >;
  for (const [styleId, mapping] of Object.entries(value.mappings)) {
    if (
      styleId === '__proto__' ||
      styleId === 'constructor' ||
      !isStyleMapping(mapping)
    )
      return { ok: false, error: 'The preset contains an invalid mapping.' };
    mappings[styleId] = mapping;
  }
  return { ok: true, mappings: { ...mappings } };
}

export function setMetadataField(
  metadata: DocumentMetadata,
  field: EditableMetadataField,
  value: string,
): DocumentMetadata {
  const next = { ...metadata };
  if (value.trim() === '' && field !== 'conversionDate') delete next[field];
  else
    Object.assign(next, {
      [field]: userValue(value),
    } satisfies Partial<DocumentMetadata>);
  return next;
}

export function setSubjects(
  metadata: DocumentMetadata,
  values: readonly string[],
): DocumentMetadata {
  return {
    ...metadata,
    subjects: values
      .map((value) => value.trim())
      .filter(Boolean)
      .map(userValue),
  };
}

export function updateAuthor(
  metadata: DocumentMetadata,
  index: number,
  person: Person,
): DocumentMetadata {
  const authors = [...metadata.authors];
  authors[index] = userValue(cleanPerson(person));
  return { ...metadata, authors };
}

export function addAuthor(metadata: DocumentMetadata): DocumentMetadata {
  return {
    ...metadata,
    authors: [...metadata.authors, userValue({ name: '' })],
  };
}

export function removeAuthor(
  metadata: DocumentMetadata,
  index: number,
): DocumentMetadata {
  return {
    ...metadata,
    authors: metadata.authors.filter((_, authorIndex) => authorIndex !== index),
  };
}

function userValue<T>(value: T): InferredValue<T> {
  return { value, provenance: USER_PROVENANCE };
}

function cleanPerson(person: Person): Person {
  return Object.fromEntries(
    Object.entries(person).filter(([, value]) => value !== ''),
  ) as unknown as Person;
}

function isHighConfidence(confidence: Confidence): boolean {
  return confidence === 'high' || confidence === 'certain';
}

function isStyleMapping(value: unknown): value is StyleMapping {
  return (
    typeof value === 'string' &&
    (STYLE_MAPPINGS as readonly string[]).includes(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}
