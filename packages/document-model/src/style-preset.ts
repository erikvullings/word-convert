import type { StyleMapping } from './index.ts';

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

export interface StylePresetImportResult {
  ok: boolean;
  mappings?: Record<string, StyleMapping>;
  error?: string;
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
