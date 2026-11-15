import type {
  DocumentMetadata,
  InferredValue,
} from '@wordconvert/document-model';

export const MAX_METADATA_FILE_BYTES = 32 * 1024;
const MAX_METADATA_TEXT_LENGTH = 16_384;
const MAX_METADATA_ITEMS = 100;
const SIDECAR_ROOT_KEYS = new Set(['schema', 'version', 'metadata']);
const METADATA_KEYS = new Set([
  'title',
  'titleSort',
  'subtitle',
  'authors',
  'authorSort',
  'language',
  'publisher',
  'description',
  'subjects',
  'version',
  'sourceCreatedAt',
  'sourceModifiedAt',
  'publicationDate',
  'identifier',
  'isbn',
  'rights',
  'series',
  'seriesIndex',
  'contributors',
  'bookProducer',
]);

export interface MetadataSidecar {
  title?: string;
  titleSort?: string;
  subtitle?: string;
  authors?: string[];
  authorSort?: string;
  language?: string;
  publisher?: string;
  description?: string;
  subjects?: string[];
  version?: string;
  sourceCreatedAt?: string;
  sourceModifiedAt?: string;
  publicationDate?: string;
  identifier?: string;
  isbn?: string;
  rights?: string;
  series?: string;
  seriesIndex?: number;
  contributors?: string[];
  bookProducer?: string;
}

export function parseMetadataSidecar(bytes: Uint8Array): MetadataSidecar {
  if (bytes.byteLength > MAX_METADATA_FILE_BYTES)
    throw new TypeError(
      `Metadata sidecar exceeds ${MAX_METADATA_FILE_BYTES} bytes.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('Metadata sidecar must be valid UTF-8 JSON.');
  }
  if (!isRecord(value))
    throw new TypeError('Metadata sidecar must be a JSON object.');
  for (const key of Object.keys(value))
    if (!SIDECAR_ROOT_KEYS.has(key))
      throw new TypeError(`Unknown metadata sidecar key: ${key}.`);
  if (value.schema !== 'wordconvert.metadata' || value.version !== 1)
    throw new TypeError(
      'Metadata sidecar schema must be wordconvert.metadata version 1.',
    );
  if (!isRecord(value.metadata))
    throw new TypeError('Metadata sidecar metadata must be a JSON object.');
  for (const key of Object.keys(value.metadata))
    if (!METADATA_KEYS.has(key))
      throw new TypeError(`Unknown metadata sidecar key: ${key}.`);
  const metadata = value.metadata;
  const result: MetadataSidecar = {};
  const stringFields = [
    'title',
    'titleSort',
    'subtitle',
    'authorSort',
    'language',
    'publisher',
    'description',
    'version',
    'sourceCreatedAt',
    'sourceModifiedAt',
    'publicationDate',
    'identifier',
    'isbn',
    'rights',
    'series',
    'bookProducer',
  ] as const;
  for (const key of stringFields) {
    const field = metadata[key];
    if (field === undefined) continue;
    if (typeof field !== 'string')
      throw new TypeError(`Metadata sidecar ${key} must be a string.`);
    const bounded = validateText(field, key);
    if (
      key === 'sourceCreatedAt' ||
      key === 'sourceModifiedAt' ||
      key === 'publicationDate'
    ) {
      result[key] = normalizeIsoDate(bounded);
    } else if (key === 'language') {
      result.language = normalizeLanguageTag(bounded);
    } else {
      result[key] = bounded;
    }
  }
  for (const key of ['authors', 'subjects', 'contributors'] as const) {
    const field = metadata[key];
    if (field === undefined) continue;
    if (
      !Array.isArray(field) ||
      field.length > MAX_METADATA_ITEMS ||
      !field.every((item) => typeof item === 'string')
    )
      throw new TypeError(
        `Metadata sidecar ${key} must be an array of at most ${MAX_METADATA_ITEMS} strings.`,
      );
    result[key] = field.map((item, index) =>
      validateText(item, `${key}[${index}]`),
    );
  }
  if (metadata.seriesIndex !== undefined) {
    if (
      typeof metadata.seriesIndex !== 'number' ||
      !Number.isFinite(metadata.seriesIndex) ||
      metadata.seriesIndex <= 0 ||
      metadata.seriesIndex > 1_000_000
    )
      throw new TypeError(
        'Metadata sidecar seriesIndex must be greater than 0 and at most 1000000.',
      );
    result.seriesIndex = metadata.seriesIndex;
  }
  return result;
}

export function applyMetadataSidecar(
  metadata: DocumentMetadata,
  sidecar: MetadataSidecar,
): DocumentMetadata {
  const next = { ...metadata };
  for (const key of [
    'title',
    'titleSort',
    'subtitle',
    'authorSort',
    'language',
    'publisher',
    'description',
    'version',
    'sourceCreatedAt',
    'sourceModifiedAt',
    'publicationDate',
    'identifier',
    'isbn',
    'rights',
    'series',
    'bookProducer',
  ] as const) {
    const value = sidecar[key];
    if (value !== undefined)
      Object.assign(next, { [key]: userValue(value, 'metadata sidecar') });
  }
  if (sidecar.seriesIndex !== undefined)
    next.seriesIndex = userValue(sidecar.seriesIndex, 'metadata sidecar');
  if (sidecar.subjects !== undefined)
    next.subjects = sidecar.subjects.map((subject) =>
      userValue(subject, 'metadata sidecar'),
    );
  if (sidecar.authors !== undefined)
    next.authors = sidecar.authors.map((name) =>
      userValue({ name }, 'metadata sidecar'),
    );
  if (sidecar.contributors !== undefined)
    next.contributors = sidecar.contributors.map((name) =>
      userValue({ name, role: 'ctb' }, 'metadata sidecar'),
    );
  return next;
}

export function normalizeIsoDate(value: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestampMatch =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  const timestamp = timestampMatch !== null;
  if (!dateOnly && !timestamp)
    throw new TypeError('Date must be a valid ISO 8601 date or timestamp.');
  const datePart = dateOnly ? value : timestampMatch?.[1];
  if (!datePart || !isValidDatePart(datePart))
    throw new TypeError('Date must be a valid ISO 8601 date or timestamp.');
  if (
    timestampMatch &&
    [timestampMatch[2], timestampMatch[3], timestampMatch[4]].some(
      (part, index) => Number(part) > [23, 59, 59][index]!,
    )
  )
    throw new TypeError('Date must be a valid ISO 8601 date or timestamp.');
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError('Date must be a valid ISO 8601 date or timestamp.');
  return dateOnly ? value : `${date.toISOString().slice(0, 19)}Z`;
}

export function normalizeLanguageTag(value: string): string {
  try {
    const [tag] = Intl.getCanonicalLocales(value);
    if (!tag) throw new RangeError();
    return tag;
  } catch {
    throw new TypeError('Language must be a valid BCP 47 language tag.');
  }
}

export function isValidIsbn(value: string): boolean {
  const isbn = value.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = Array.from(isbn).reduce(
      (total, digit, index) =>
        total + (digit === 'X' ? 10 : Number(digit)) * (10 - index),
      0,
    );
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = Array.from(isbn).reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
    return sum % 10 === 0;
  }
  return false;
}

function validateText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed)
    throw new TypeError(`Metadata sidecar ${field} must not be empty.`);
  if (trimmed.length > MAX_METADATA_TEXT_LENGTH)
    throw new TypeError(
      `Metadata sidecar ${field} must be no longer than ${MAX_METADATA_TEXT_LENGTH} characters.`,
    );
  if (/https?:\/\//i.test(trimmed))
    throw new TypeError(
      'Metadata sidecar values must not contain remote URLs.',
    );
  return trimmed;
}

function userValue<T>(value: T, source: string): InferredValue<T> {
  return {
    value,
    provenance: { source, method: 'user', confidence: 'certain' },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isValidDatePart(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year >= 0 && year < 100) date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
