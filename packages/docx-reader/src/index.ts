import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type AnalysedStyle,
  type BlockNode,
  type ConversionWarning,
  type DocxReader,
  type DocxReaderOptions,
  type DocumentModel,
  type Equation,
  type InlineNode,
  type Note,
  type TableCell,
  type TextMark,
} from '@wordconvert/document-model';

import {
  analyseStyles,
  applyStyleMappings,
  resolveMetadataCandidates,
  type MetadataCandidate,
  type RawStyle,
  type StyleUsage,
} from './analysis.ts';

import { fail } from './error.ts';
import {
  openDocxPackage,
  type DocxPackage,
  type ReaderLimits,
} from './package.ts';
import {
  attribute,
  descendants,
  elements,
  first,
  isNode,
  localName,
  parseXml,
  textContent,
  type XmlNode,
} from './xml.ts';

export { DocxReadError } from './error.ts';
export {
  analyseStyles,
  applyStyleMappings,
  resolveMetadataCandidates,
} from './analysis.ts';
export type {
  MetadataCandidate,
  MetadataField,
  RawStyle,
  StyleAnalysisOptions,
  StyleUsage,
} from './analysis.ts';

const DEFAULT_LIMITS: ReaderLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 1_000,
  maxCompressionRatio: 100,
};
const safeExternalProtocols = new Set(['http:', 'https:', 'mailto:']);
const activeMedia = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
]);

interface Relationship {
  target: string;
  type: string;
  external: boolean;
}

interface ParseContext {
  pkg: DocxPackage;
  relationships: Map<string, Relationship>;
  numbering: Map<string, boolean>;
  equations: Record<string, Equation>;
  assets: DocumentModel['assets'];
  warnings: ConversionWarning[];
  equationNumber: number;
  assetNumber: number;
}

function requiredXml(pkg: DocxPackage, name: string): XmlNode {
  const bytes = pkg.xml(name);
  if (!bytes)
    fail('invalid-input', 'DOCX is missing a required package part.', {
      part: name,
    });
  return parseXml(bytes, name);
}

function optionalXml(pkg: DocxPackage, name: string): XmlNode | undefined {
  const bytes = pkg.xml(name);
  return bytes ? parseXml(bytes, name) : undefined;
}

function parseRelationships(
  pkg: DocxPackage,
  name: string,
): Map<string, Relationship> {
  const root = optionalXml(pkg, name);
  const relationships = new Map<string, Relationship>();
  if (!root) return relationships;
  for (const node of elements(root, 'Relationship')) {
    const id = attribute(node, 'Id');
    const target = attribute(node, 'Target');
    if (id && target)
      relationships.set(id, {
        target,
        type: attribute(node, 'Type') ?? '',
        external: attribute(node, 'TargetMode') === 'External',
      });
  }
  return relationships;
}

function validatePackage(pkg: DocxPackage): void {
  const types = requiredXml(pkg, '[Content_Types].xml');
  const overrides = elements(types, 'Override');
  const documentType = overrides.find(
    (node) => attribute(node, 'PartName') === '/word/document.xml',
  );
  const contentType = documentType && attribute(documentType, 'ContentType');
  if (!contentType?.endsWith('wordprocessingml.document.main+xml'))
    fail('unsupported-format', 'Package is not an unencrypted DOCX document.');
  const defaults = new Map(
    elements(types, 'Default').map((node) => [
      attribute(node, 'Extension')?.toLowerCase(),
      attribute(node, 'ContentType'),
    ]),
  );
  for (const name of Object.keys(pkg.entries)) {
    const extension = name.split('.').at(-1)?.toLowerCase();
    const declared = overrides.find(
      (node) => attribute(node, 'PartName') === `/${name}`,
    );
    const mediaType = declared
      ? attribute(declared, 'ContentType')
      : defaults.get(extension);
    if (mediaType && activeMedia.has(mediaType))
      fail('unsupported-format', 'DOCX contains an active media resource.', {
        mediaType,
      });
    if (extension === 'svg' || extension === 'html' || extension === 'xhtml')
      fail('unsupported-format', 'DOCX contains an active media resource.', {
        extension: extension ?? '',
      });
  }
}

function parseNumbering(pkg: DocxPackage): Map<string, boolean> {
  const root = optionalXml(pkg, 'word/numbering.xml');
  const result = new Map<string, boolean>();
  if (!root) return result;
  const formats = new Map<string, Map<string, boolean>>();
  for (const abstract of elements(root, 'abstractNum')) {
    const id = attribute(abstract, 'abstractNumId');
    if (!id) continue;
    const levels = new Map<string, boolean>();
    for (const level of elements(abstract, 'lvl')) {
      const levelId = attribute(level, 'ilvl') ?? '0';
      levels.set(
        levelId,
        attribute(first(level, 'numFmt') ?? level, 'val') !== 'bullet',
      );
    }
    formats.set(id, levels);
  }
  for (const number of elements(root, 'num')) {
    const id = attribute(number, 'numId');
    const abstractId = attribute(
      first(number, 'abstractNumId') ?? number,
      'val',
    );
    if (id) {
      for (const [level, ordered] of formats.get(abstractId ?? '') ?? [])
        result.set(`${id}:${level}`, ordered);
    }
  }
  return result;
}

function marksForRun(run: XmlNode): TextMark[] | undefined {
  const properties = first(run, 'rPr');
  if (!properties) return undefined;
  const marks: TextMark[] = [];
  if (first(properties, 'b')) marks.push({ type: 'bold' });
  if (first(properties, 'i')) marks.push({ type: 'italic' });
  if (first(properties, 'u')) marks.push({ type: 'underline' });
  if (first(properties, 'strike') || first(properties, 'dstrike'))
    marks.push({ type: 'strikethrough' });
  const vertical = attribute(
    first(properties, 'vertAlign') ?? properties,
    'val',
  );
  if (vertical === 'subscript' || vertical === 'superscript')
    marks.push({ type: vertical });
  const styleId = attribute(first(properties, 'rStyle') ?? properties, 'val');
  if (styleId) marks.push({ type: 'style', styleId });
  return marks.length ? marks : undefined;
}

function addEquation(node: XmlNode, context: ParseContext): InlineNode {
  const id = `equation-${++context.equationNumber}`;
  context.equations[id] = {
    id,
    source: { format: 'omml', value: serializeXml(node) },
    conversionComplete: false,
  };
  return { type: 'equation', equationId: id };
}

function serializeXml(node: XmlNode): string {
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  return `<${node.name}${attributes}>${node.children.map((child) => (isNode(child) ? serializeXml(child) : escapeXml(child))).join('')}</${node.name}>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function assetForRelationship(
  id: string,
  context: ParseContext,
): string | undefined {
  const relationship = context.relationships.get(id);
  if (!relationship) return undefined;
  if (relationship.external)
    fail(
      'unsupported-format',
      'Remote resources are not allowed in DOCX packages.',
    );
  const normalized = relationship.target.replace(/^\.\//, '');
  const path = normalized.startsWith('/')
    ? normalized.slice(1)
    : `word/${normalized}`;
  const bytes = context.pkg.entries[path];
  if (!bytes) return undefined;
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const mediaTypes: Record<string, string> = {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  const mediaType = mediaTypes[extension];
  if (!mediaType)
    fail('unsupported-format', 'DOCX image format is not safe or supported.', {
      extension,
    });
  const assetId = `asset-${++context.assetNumber}`;
  const filename = path.split('/').at(-1);
  context.assets[assetId] = {
    id: assetId,
    mediaType,
    data: bytes,
    ...(filename ? { filename } : {}),
  };
  return assetId;
}

function parseRun(run: XmlNode, context: ParseContext): InlineNode[] {
  const marks = marksForRun(run);
  const result: InlineNode[] = [];
  for (const child of elements(run)) {
    const name = localName(child);
    if (name === 't' || name === 'delText' || name === 'instrText') {
      const text = textContent(child);
      if (text)
        result.push({ type: 'text', text, ...(marks ? { marks } : {}) });
    } else if (name === 'tab')
      result.push({ type: 'text', text: '\t', ...(marks ? { marks } : {}) });
    else if (name === 'br')
      result.push({
        type: attribute(child, 'type') === 'page' ? 'softBreak' : 'lineBreak',
      });
    else if (name === 'footnoteReference' || name === 'endnoteReference') {
      const id = attribute(child, 'id');
      if (id)
        result.push({
          type: 'noteReference',
          noteId: `${name === 'footnoteReference' ? 'footnote' : 'endnote'}-${id}`,
        });
    } else if (name === 'drawing' || name === 'pict') {
      for (const blip of descendants(child, 'blip')) {
        const id = attribute(blip, 'embed');
        const assetId = id && assetForRelationship(id, context);
        if (assetId) result.push({ type: 'image', assetId });
      }
    }
  }
  return result;
}

function parseInlines(parent: XmlNode, context: ParseContext): InlineNode[] {
  const result: InlineNode[] = [];
  for (const child of elements(parent)) {
    const name = localName(child);
    if (name === 'r') result.push(...parseRun(child, context));
    else if (name === 'hyperlink') {
      const children = parseInlines(child, context);
      const relationship = context.relationships.get(
        attribute(child, 'id') ?? '',
      );
      if (!relationship || !relationship.external) result.push(...children);
      else {
        const protocol = /^([a-z][a-z\d+.-]*):/i
          .exec(relationship.target)?.[1]
          ?.toLowerCase();
        if (!protocol)
          fail(
            'unsupported-format',
            'DOCX contains an invalid external hyperlink.',
          );
        if (!safeExternalProtocols.has(`${protocol}:`))
          fail(
            'unsupported-format',
            'DOCX contains an unsafe hyperlink protocol.',
            { protocol },
          );
        result.push({ type: 'link', href: relationship.target, children });
      }
    } else if (name === 'oMath' || name === 'oMathPara')
      result.push(addEquation(child, context));
    else if (name === 'ins' || name === 'smartTag' || name === 'sdt')
      result.push(...parseInlines(child, context));
    else if (name === 'del')
      context.warnings.push({
        code: 'tracked-deletion-omitted',
        severity: 'info',
        message: 'Tracked deleted text was omitted.',
      });
  }
  return result;
}

function parseParagraph(node: XmlNode, context: ParseContext): BlockNode {
  const properties = first(node, 'pPr');
  const styleId =
    properties && attribute(first(properties, 'pStyle') ?? properties, 'val');
  const children = parseInlines(node, context);
  return { type: 'paragraph', children, ...(styleId ? { styleId } : {}) };
}

function parseTable(node: XmlNode, context: ParseContext): BlockNode {
  return {
    type: 'table',
    rows: elements(node, 'tr').map((row) => ({
      cells: elements(row, 'tc').map((cell): TableCell => ({
        blocks: parseBlocks(cell, context),
        ...(attribute(
          first(first(cell, 'tcPr') ?? cell, 'gridSpan') ?? cell,
          'val',
        )
          ? {
              colSpan: Number(
                attribute(
                  first(first(cell, 'tcPr') ?? cell, 'gridSpan') ?? cell,
                  'val',
                ),
              ),
            }
          : {}),
      })),
    })),
  };
}

function parseBlocks(parent: XmlNode, context: ParseContext): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const child of elements(parent)) {
    const name = localName(child);
    if (name === 'p') {
      const paragraph = parseParagraph(child, context);
      const numPr = first(first(child, 'pPr') ?? child, 'numPr');
      const numId = numPr && attribute(first(numPr, 'numId') ?? numPr, 'val');
      if (numId) {
        const level = Number(
          attribute(first(numPr, 'ilvl') ?? numPr, 'val') ?? 0,
        );
        appendListParagraph(
          blocks,
          paragraph,
          context.numbering.get(`${numId}:${level}`) ?? false,
          level,
        );
      } else blocks.push(paragraph);
    } else if (name === 'tbl') blocks.push(parseTable(child, context));
    else if (name === 'sdt') blocks.push(...parseBlocks(child, context));
  }
  return blocks;
}

function appendListParagraph(
  blocks: BlockNode[],
  paragraph: BlockNode,
  ordered: boolean,
  level: number,
): void {
  let list = blocks.at(-1);
  if (list?.type !== 'list') {
    list = { type: 'list', ordered: level === 0 ? ordered : false, items: [] };
    blocks.push(list);
  }
  if (level === 0) {
    if (list.ordered !== ordered) {
      list = { type: 'list', ordered, items: [] };
      blocks.push(list);
    }
    list.items.push({ blocks: [paragraph] });
    return;
  }
  const parentItem = list.items.at(-1) ?? { blocks: [] };
  if (!list.items.length) list.items.push(parentItem);
  appendListParagraph(parentItem.blocks, paragraph, ordered, level - 1);
}

function parseNotes(
  pkg: DocxPackage,
  context: ParseContext,
): Record<string, Note> {
  const notes: Record<string, Note> = {};
  for (const [kind, path, elementName] of [
    ['footnote', 'word/footnotes.xml', 'footnote'],
    ['endnote', 'word/endnotes.xml', 'endnote'],
  ] as const) {
    const root = optionalXml(pkg, path);
    if (!root) continue;
    for (const node of elements(root, elementName)) {
      const sourceId = attribute(node, 'id');
      if (!sourceId || Number(sourceId) < 0) continue;
      const id = `${kind}-${sourceId}`;
      notes[id] = { id, kind, blocks: parseBlocks(node, context) };
    }
  }
  return notes;
}

function points(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value) / 20;
}

function rawFormatting(node: XmlNode): RawStyle['formatting'] {
  const paragraph = first(node, 'pPr');
  const run = first(node, 'rPr');
  const spacing = paragraph && first(paragraph, 'spacing');
  const indentation = paragraph && first(paragraph, 'ind');
  const fonts = run && first(run, 'rFonts');
  const fontFamily =
    fonts && (attribute(fonts, 'ascii') ?? attribute(fonts, 'hAnsi'));
  const size = run && attribute(first(run, 'sz') ?? run, 'val');
  const outline =
    paragraph && attribute(first(paragraph, 'outlineLvl') ?? paragraph, 'val');
  const numbering = paragraph && first(paragraph, 'numPr');
  const spacingBeforePt = points(spacing && attribute(spacing, 'before'));
  const spacingAfterPt = points(spacing && attribute(spacing, 'after'));
  const indentationLeftPt = points(
    indentation && attribute(indentation, 'left'),
  );
  const indentationRightPt = points(
    indentation && attribute(indentation, 'right'),
  );
  const indentationFirstLinePt = points(
    indentation && attribute(indentation, 'firstLine'),
  );
  return {
    ...(fontFamily ? { fontFamily } : {}),
    ...(size ? { fontSizePt: Number(size) / 2 } : {}),
    ...(run && first(run, 'b') ? { bold: true } : {}),
    ...(run && first(run, 'i') ? { italic: true } : {}),
    ...(outline !== undefined ? { outlineLevel: Number(outline) } : {}),
    ...(spacingBeforePt !== undefined ? { spacingBeforePt } : {}),
    ...(spacingAfterPt !== undefined ? { spacingAfterPt } : {}),
    ...(indentationLeftPt !== undefined ? { indentationLeftPt } : {}),
    ...(indentationRightPt !== undefined ? { indentationRightPt } : {}),
    ...(indentationFirstLinePt !== undefined ? { indentationFirstLinePt } : {}),
    ...(numbering
      ? {
          numbering: `${attribute(first(numbering, 'numId') ?? numbering, 'val') ?? ''}:${attribute(first(numbering, 'ilvl') ?? numbering, 'val') ?? '0'}`,
        }
      : {}),
  };
}

function parseRawStyles(pkg: DocxPackage): RawStyle[] {
  const root = optionalXml(pkg, 'word/styles.xml');
  if (!root) return [];
  return elements(root, 'style').flatMap((node): RawStyle[] => {
    const id = attribute(node, 'styleId');
    const kind = attribute(node, 'type');
    if (!id || (kind !== 'paragraph' && kind !== 'character')) return [];
    const name = attribute(first(node, 'name') ?? node, 'val');
    const basedOn = attribute(first(node, 'basedOn') ?? node, 'val');
    return [
      {
        id,
        ...(name ? { name } : {}),
        kind,
        ...(attribute(node, 'default') === '1' ? { default: true } : {}),
        ...(basedOn ? { basedOn } : {}),
        formatting: rawFormatting(node),
      },
    ];
  });
}

function styleUsages(
  document: XmlNode,
  styles: readonly RawStyle[],
): StyleUsage[] {
  const usages: StyleUsage[] = [];
  const defaultParagraph = styles.find(
    ({ kind, default: isDefault }) => kind === 'paragraph' && isDefault,
  )?.id;
  let position = 0;
  for (const paragraph of descendants(document, 'p')) {
    const properties = first(paragraph, 'pPr');
    const styleId =
      (properties &&
        attribute(first(properties, 'pStyle') ?? properties, 'val')) ??
      defaultParagraph;
    const text = textContent(paragraph).trim();
    if (styleId)
      usages.push({
        styleId,
        kind: 'paragraph',
        text,
        position: position++,
        formatting: rawFormatting(paragraph),
        numbered: Boolean(properties && first(properties, 'numPr')),
      });
    for (const run of descendants(paragraph, 'r')) {
      const runProperties = first(run, 'rPr');
      const characterStyle =
        runProperties &&
        attribute(first(runProperties, 'rStyle') ?? runProperties, 'val');
      if (characterStyle)
        usages.push({
          styleId: characterStyle,
          kind: 'character',
          text: textContent(run).trim(),
          position: position++,
          formatting: rawFormatting(run),
        });
    }
  }
  return usages;
}

function metadataValue(
  root: XmlNode | undefined,
  name: string,
): string | undefined {
  const node = root && descendants(root, name)[0];
  return node ? textContent(node).trim() || undefined : undefined;
}

function metadataCandidates(
  pkg: DocxPackage,
  usages: readonly StyleUsage[],
  filename?: string,
): MetadataCandidate[] {
  const core = optionalXml(pkg, 'docProps/core.xml');
  const app = optionalXml(pkg, 'docProps/app.xml');
  const custom = optionalXml(pkg, 'docProps/custom.xml');
  const value = (name: string) => metadataValue(core, name);
  const candidates: MetadataCandidate[] = [];
  const add = (
    field: MetadataCandidate['field'],
    candidateValue: string | undefined,
    source: string,
    priority: MetadataCandidate['priority'],
  ): void => {
    if (candidateValue)
      candidates.push({
        field,
        value: candidateValue,
        source,
        priority,
        confidence: 'certain',
        method: 'extracted',
      });
  };
  add('title', value('title'), 'docProps/core.xml', 1);
  for (const author of value('creator')
    ?.split(/;|\n/)
    .map((item) => item.trim())
    .filter(Boolean) ?? [])
    candidates.push({
      field: 'authors',
      value: { name: author },
      source: 'docProps/core.xml',
      priority: 1,
      confidence: 'certain',
      method: 'extracted',
    });
  add('language', value('language'), 'docProps/core.xml', 1);
  add('description', value('description'), 'docProps/core.xml', 1);
  for (const subject of [value('subject'), value('keywords')].filter(
    (item): item is string => Boolean(item),
  ))
    candidates.push({
      field: 'subjects',
      value: subject,
      source: 'docProps/core.xml',
      priority: 1,
      confidence: 'certain',
      method: 'extracted',
    });
  add('sourceCreatedAt', value('created'), 'docProps/core.xml', 1);
  add('sourceModifiedAt', value('modified'), 'docProps/core.xml', 1);
  add('publisher', metadataValue(app, 'Company'), 'docProps/app.xml', 2);
  for (const property of custom ? elements(custom, 'property') : []) {
    const fieldName = normalisedPropertyName(attribute(property, 'name') ?? '');
    const candidateValue = textContent(property).trim() || undefined;
    if (fieldName)
      add(
        fieldName,
        candidateValue,
        `docProps/custom.xml:${attribute(property, 'name') ?? ''}`,
        3,
      );
  }
  for (const usage of usages) {
    if (/^title$/i.test(usage.styleId))
      add('title', usage.text, 'Title style', 4);
    else if (/^subtitle$/i.test(usage.styleId))
      add('subtitle', usage.text, 'Subtitle style', 4);
    else if (/^author$/i.test(usage.styleId) && usage.text)
      candidates.push({
        field: 'authors',
        value: { name: usage.text },
        source: 'Author style',
        priority: 4,
        confidence: 'high',
        method: 'inferred',
      });
  }
  const firstText = usages.find(
    ({ kind, text }) => kind === 'paragraph' && text,
  )?.text;
  if (firstText)
    candidates.push({
      field: 'title',
      value: firstText,
      source: 'first-page structure',
      priority: 5,
      confidence: 'low',
      method: 'inferred',
    });
  const filenameTitle = filename?.replace(/\.docx$/i, '').trim();
  if (filenameTitle)
    candidates.push({
      field: 'title',
      value: filenameTitle,
      source: 'filename',
      priority: 7,
      confidence: 'low',
      method: 'inferred',
    });
  return candidates;
}

function normalisedPropertyName(
  name: string,
): Exclude<MetadataCandidate['field'], 'authors' | 'subjects'> | undefined {
  const key = name.toLowerCase().replaceAll(/[^a-z]/g, '');
  const fields: Readonly<
    Record<string, Exclude<MetadataCandidate['field'], 'authors' | 'subjects'>>
  > = {
    version: 'version',
    publicationdate: 'publicationDate',
    publisher: 'publisher',
    rights: 'rights',
    identifier: 'identifier',
    subtitle: 'subtitle',
    description: 'description',
    language: 'language',
  };
  return fields[key];
}

function checkCancellation(options: DocxReaderOptions): void {
  if (options.cancellation?.cancelled)
    fail('cancelled', 'DOCX reading was cancelled.');
}

export const secureDocxReader: DocxReader = {
  implementation: 'wordconvert-secure-ooxml-v1',
  async read(input, options) {
    checkCancellation(options);
    options.onProgress?.({ phase: 'inspect', completed: 0, total: 1 });
    const limits: ReaderLimits = { ...DEFAULT_LIMITS, ...options.limits };
    const pkg = openDocxPackage(input, limits);
    validatePackage(pkg);
    const relationships = parseRelationships(
      pkg,
      'word/_rels/document.xml.rels',
    );
    for (const relationship of relationships.values()) {
      if (relationship.external && relationship.type.endsWith('/image'))
        fail(
          'unsupported-format',
          'Remote resources are not allowed in DOCX packages.',
        );
    }
    checkCancellation(options);
    options.onProgress?.({ phase: 'read', completed: 0, total: 1 });
    const warnings: ConversionWarning[] = [];
    const context: ParseContext = {
      pkg,
      relationships,
      numbering: parseNumbering(pkg),
      equations: {},
      assets: {},
      warnings,
      equationNumber: 0,
      assetNumber: 0,
    };
    const document = requiredXml(pkg, 'word/document.xml');
    const body = descendants(document, 'body')[0];
    if (!body) fail('invalid-input', 'Word document has no body.');
    if (
      [...relationships.values()].some(
        (relationship) =>
          relationship.type.endsWith('/header') ||
          relationship.type.endsWith('/footer'),
      )
    ) {
      warnings.push({
        code: 'decorative-furniture-omitted',
        severity: 'info',
        message: 'Headers and footers were omitted from main content.',
      });
    }
    if (pkg.entries['word/comments.xml']) {
      requiredXml(pkg, 'word/comments.xml');
      warnings.push({
        code: 'comments-omitted',
        severity: 'info',
        message:
          'Review comments were inspected but omitted from main content.',
      });
    }
    const rawStyles = parseRawStyles(pkg);
    const usages = styleUsages(document, rawStyles);
    const styles: AnalysedStyle[] = analyseStyles(rawStyles, usages, {
      ...(options.stylePreset ? { preset: options.stylePreset } : {}),
      ...(options.styleMappings ? { mappings: options.styleMappings } : {}),
    });
    const mappings = Object.fromEntries(
      styles.map(({ id, proposedMapping }) => [id, proposedMapping]),
    );
    const rawBlocks = parseBlocks(body, context);
    const model: DocumentModel = {
      schema: DOCUMENT_MODEL_SCHEMA,
      version: DOCUMENT_MODEL_VERSION,
      metadata: resolveMetadataCandidates(
        metadataCandidates(pkg, usages, options.filename),
        options.conversionDate,
      ),
      blocks: applyStyleMappings(rawBlocks, mappings),
      assets: context.assets,
      equations: context.equations,
      notes: parseNotes(pkg, context),
      styles,
      warnings,
    };
    options.onProgress?.({ phase: 'read', completed: 1, total: 1 });
    return model;
  },
};

export function createDocxReader(): DocxReader {
  return secureDocxReader;
}
