import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type AnalysedStyle,
  type BlockNode,
  type ConversionOptions,
  type ConversionWarning,
  type DocumentMetadata,
  type DocumentModel,
  type InferredValue,
  type InlineNode,
  type Person,
  type Provenance,
  type StyleMapping,
} from '@wordconvert/document-model';
import { PdfReadError } from './error.ts';
import { extractPdfWithPdfJs, type PdfReaderLimits } from './pdfjs.ts';
export { configurePdfJsWorker } from './pdfjs.ts';

export { PdfReadError } from './error.ts';

export interface RawPdfTextSpan {
  id: string;
  text: string;
  /** Page-relative left coordinate after page rotation, in the range 0..1. */
  x: number;
  /** Page-relative top coordinate after page rotation, in the range 0..1. */
  top: number;
  width: number;
  height: number;
  fontId: string;
  fontFamily?: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  direction: 'ltr' | 'rtl' | 'ttb';
  linkId?: string;
  markedContentId?: string;
}

export interface RawPdfLink {
  id: string;
  href: string;
  x: number;
  top: number;
  width: number;
  height: number;
}

export interface RawPdfImage {
  id: string;
  x: number;
  top: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  mediaType: 'image/png' | 'image/jpeg';
  data: Uint8Array;
}

export interface RawPdfPage {
  number: number;
  width: number;
  height: number;
  rotation: number;
  spans: RawPdfTextSpan[];
  links: RawPdfLink[];
  images: RawPdfImage[];
  taggedStructure?: RawPdfStructureNode;
}

export interface RawPdfStructureNode {
  role: string;
  markedContentId?: string;
  children: RawPdfStructureNode[];
}

export interface RawPdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  language?: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface RawPdfOutlineItem {
  title: string;
  destination?: string;
  children: RawPdfOutlineItem[];
}

export interface RawPdfDocument {
  version: 1;
  pageCount: number;
  pages: RawPdfPage[];
  metadata: RawPdfMetadata;
  outline: RawPdfOutlineItem[];
}

export interface PdfCropOptions {
  /** Fraction of each rotated page excluded from the top. */
  top: number;
  /** Fraction of each rotated page excluded from the bottom. */
  bottom: number;
}

export interface PdfAnalysisOptions extends ConversionOptions {
  filename?: string;
  crop?: Partial<PdfCropOptions>;
  removeDetectedFurniture?: boolean;
  removedCandidateIds?: readonly string[];
  retainedCandidateIds?: readonly string[];
  styleMappings?: Readonly<Record<string, StyleMapping>>;
}

export interface PdfFurnitureCandidate {
  id: string;
  kind: 'header' | 'footer' | 'page-number';
  text: string;
  normalizedText: string;
  pageParity: 'odd' | 'even';
  pageNumbers: number[];
  confidence: 'low' | 'medium' | 'high';
  removed: boolean;
}

export interface PdfAnalysisSummary {
  pageCount: number;
  analysedPages: number[];
  crop: PdfCropOptions;
  candidates: PdfFurnitureCandidate[];
  scannedPages: number[];
}

export interface PdfAnalysisResult {
  model: DocumentModel;
  analysis: PdfAnalysisSummary;
}

export interface PdfReaderOptions extends PdfAnalysisOptions {
  limits?: Partial<PdfReaderLimits>;
  samplePageCount?: number;
}

export interface PdfReader {
  readonly implementation: string;
  readRaw(
    input: Uint8Array,
    options: PdfReaderOptions,
  ): Promise<RawPdfDocument>;
  read(
    input: Uint8Array,
    options: PdfReaderOptions,
  ): Promise<PdfAnalysisResult>;
}

const DEFAULT_LIMITS: PdfReaderLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxPages: 2_000,
  maxTextItems: 2_000_000,
  maxTextItemsPerPage: 100_000,
  maxImages: 10_000,
  maxImagePixels: 40_000_000,
  maxTotalImagePixels: 80_000_000,
};

export const pdfJsReader: PdfReader = {
  implementation: 'pdfjs',
  async readRaw(input, options) {
    validateInput(input);
    return extractPdfWithPdfJs(input, {
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      ...(options.cancellation ? { cancellation: options.cancellation } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.samplePageCount !== undefined
        ? { samplePageCount: options.samplePageCount }
        : {}),
    });
  },
  async read(input, options) {
    const raw = await this.readRaw(input, options);
    options.onProgress?.({
      phase: 'analyse',
      completed: 0,
      total: 1,
    });
    const result = await analysePdf(raw, options);
    options.onProgress?.({
      phase: 'analyse',
      completed: 1,
      total: 1,
    });
    return result;
  },
};

function validateInput(input: Uint8Array): void {
  if (!(input instanceof Uint8Array) || input.byteLength === 0)
    throw new PdfReadError('invalid-input', 'PDF input is empty.', {
      phase: 'inspect',
    });
  if (
    input[0] !== 0x25 ||
    input[1] !== 0x50 ||
    input[2] !== 0x44 ||
    input[3] !== 0x46 ||
    input[4] !== 0x2d
  )
    throw new PdfReadError(
      'unsupported-format',
      'Input is not a PDF document.',
      {
        phase: 'inspect',
      },
    );
}

interface PdfLine {
  page: number;
  spans: RawPdfTextSpan[];
  text: string;
  x: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontId: string;
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
}

const DEFAULT_CROP: PdfCropOptions = { top: 0, bottom: 0 };
const FURNITURE_BAND = 0.15;

export async function analysePdf(
  raw: RawPdfDocument,
  options: PdfAnalysisOptions,
): Promise<PdfAnalysisResult> {
  const crop = validateCrop(options.crop);
  const candidates = await detectFurniture(raw, options);
  const removedCandidateIds = new Set(
    candidates.filter(({ removed }) => removed).map(({ id }) => id),
  );
  const candidateBySpan = await furnitureSpanIds(
    raw,
    removedCandidateIds,
    options,
  );
  const croppedSpanIds = new Set<string>();
  const warnings: ConversionWarning[] = [];
  const scannedPages: number[] = [];
  const retainedPages: RawPdfPage[] = [];
  for (const page of raw.pages) {
    await analysisCheckpoint(options);
    if (page.spans.every(({ text }) => !text.trim()))
      scannedPages.push(page.number);
    const spans = page.spans.filter((span) => {
      const cropped =
        span.top < crop.top || span.top + span.height > 1 - crop.bottom;
      if (cropped) croppedSpanIds.add(span.id);
      return !cropped && !candidateBySpan.has(span.id);
    });
    retainedPages.push({ ...page, spans });
  }

  if (croppedSpanIds.size > 0)
    warnings.push({
      code: 'pdf-cropped-page-furniture',
      severity: 'info',
      message: 'Content inside the configured PDF crop regions was omitted.',
      details: { textSpans: croppedSpanIds.size },
    });
  if (candidateBySpan.size > 0)
    warnings.push({
      code: 'pdf-repeated-page-furniture',
      severity: 'info',
      message: 'Repeated PDF headers, footers, or page numbers were omitted.',
      details: { textSpans: candidateBySpan.size },
    });
  if (scannedPages.length > 0)
    warnings.push({
      code: 'pdf-ocr-not-supported',
      severity: 'warning',
      message:
        'One or more PDF pages contain no extractable text. OCR is not supported yet.',
      details: { pages: scannedPages.length },
    });

  const lines: PdfLine[] = [];
  for (const page of retainedPages) {
    await analysisCheckpoint(options);
    lines.push(...(await readingOrder(page, options)));
  }
  const styles = await analyseStyles(lines, options.styleMappings, options);
  const blocks = await linesToBlocks(lines, styles, retainedPages, options);
  return {
    model: {
      schema: DOCUMENT_MODEL_SCHEMA,
      version: DOCUMENT_MODEL_VERSION,
      metadata: metadata(raw, options),
      blocks,
      assets: Object.fromEntries(
        retainedPages.flatMap((page) =>
          page.images.map((image) => [
            image.id,
            {
              id: image.id,
              mediaType: image.mediaType,
              data: image.data,
              width: image.pixelWidth,
              height: image.pixelHeight,
            },
          ]),
        ),
      ),
      equations: {},
      notes: {},
      styles,
      warnings,
    },
    analysis: {
      pageCount: raw.pageCount,
      analysedPages: raw.pages.map(({ number }) => number),
      crop,
      candidates,
      scannedPages,
    },
  };
}

function validateCrop(
  crop: Partial<PdfCropOptions> | undefined,
): PdfCropOptions {
  const value = { ...DEFAULT_CROP, ...crop };
  for (const [edge, amount] of Object.entries(value)) {
    if (!Number.isFinite(amount) || amount < 0 || amount > 0.45)
      throw new RangeError(`PDF ${edge} crop must be between 0 and 0.45.`);
  }
  if (value.top + value.bottom >= 0.9)
    throw new RangeError('PDF crop regions leave no usable page content.');
  return value;
}

async function readingOrder(
  page: RawPdfPage,
  options: PdfAnalysisOptions,
): Promise<PdfLine[]> {
  const lines = await groupLines(page, options);
  const ordered: PdfLine[] = [];
  let section: PdfLine[] = [];
  const flush = (): void => {
    if (section.length === 0) return;
    const left = section.filter((line) => line.x + line.width / 2 < 0.5);
    const right = section.filter((line) => line.x + line.width / 2 >= 0.5);
    const isTwoColumn =
      left.length > 0 &&
      right.length > 0 &&
      left.reduce(
        (maximum, line) => Math.max(maximum, line.x + line.width),
        0,
      ) <
        right.reduce(
          (minimum, line) => Math.min(minimum, line.x),
          Number.POSITIVE_INFINITY,
        );
    ordered.push(
      ...(isTwoColumn
        ? [...left.sort(byTop), ...right.sort(byTop)]
        : section.sort(byTop)),
    );
    section = [];
  };
  await analysisCheckpoint(options);
  lines.sort(byTop);
  for (let index = 0; index < lines.length; index++) {
    if (index % 1_000 === 0) await analysisCheckpoint(options);
    const line = lines[index]!;
    if (line.width >= 0.65) {
      flush();
      ordered.push(line);
    } else {
      section.push(line);
    }
  }
  flush();
  return taggedReadingOrder(ordered, page.taggedStructure);
}

function taggedReadingOrder(
  lines: readonly PdfLine[],
  structure: RawPdfStructureNode | undefined,
): PdfLine[] {
  if (!structure) return [...lines];
  const ranks = new Map<string, number>();
  const visit = (node: RawPdfStructureNode): void => {
    if (node.markedContentId && !ranks.has(node.markedContentId))
      ranks.set(node.markedContentId, ranks.size);
    node.children.forEach(visit);
  };
  visit(structure);
  const ranked = lines
    .map((line) => ({
      line,
      rank: Math.min(
        ...line.spans
          .map(({ markedContentId }) =>
            markedContentId === undefined
              ? Number.POSITIVE_INFINITY
              : (ranks.get(markedContentId) ?? Number.POSITIVE_INFINITY),
          )
          .filter(Number.isFinite),
      ),
    }))
    .filter(({ rank }) => Number.isFinite(rank));
  if (ranked.length < 2) return [...lines];
  const rankByLine = new Map(ranked.map(({ line, rank }) => [line, rank]));
  return [...lines].sort((left, right) => {
    const leftRank = rankByLine.get(left);
    const rightRank = rankByLine.get(right);
    if (leftRank !== undefined && rightRank !== undefined)
      return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return lines.indexOf(left) - lines.indexOf(right);
  });
}

async function groupLines(
  page: RawPdfPage,
  options: PdfAnalysisOptions,
): Promise<PdfLine[]> {
  const sorted = [...page.spans].sort(
    (left, right) => left.top - right.top || left.x - right.x,
  );
  await analysisCheckpoint(options);
  const groups: RawPdfTextSpan[][] = [];
  for (let index = 0; index < sorted.length; index++) {
    if (index % 1_000 === 0) await analysisCheckpoint(options);
    const span = sorted[index]!;
    const threshold = Math.max(span.height, 0.008) * 0.55;
    let low = 0;
    let high = groups.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((groups[middle]?.[0]?.top ?? span.top) < span.top - threshold)
        low = middle + 1;
      else high = middle;
    }
    const line =
      Math.abs((groups[low]?.[0]?.top ?? span.top) - span.top) <= threshold
        ? groups[low]
        : undefined;
    if (line) line.push(span);
    else groups.push([span]);
  }
  const logicalLines: RawPdfTextSpan[][] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    if (groupIndex % 1_000 === 0) await analysisCheckpoint(options);
    const row = groups[groupIndex]!;
    row.sort((left, right) => left.x - right.x);
    const lines: RawPdfTextSpan[][] = [];
    for (const span of row) {
      const line = lines.at(-1);
      const previous = line?.at(-1);
      if (previous && span.x - (previous.x + previous.width) <= 0.08)
        line?.push(span);
      else lines.push([span]);
    }
    logicalLines.push(...lines);
  }
  const output: PdfLine[] = [];
  for (let index = 0; index < logicalLines.length; index++) {
    if (index % 1_000 === 0) await analysisCheckpoint(options);
    const spans = logicalLines[index]!;
    spans.sort((left, right) => left.x - right.x);
    const first = spans[0];
    if (!first) continue;
    let x = first.x;
    let right = first.x + first.width;
    let top = first.top;
    let height = first.height;
    let fontSize = first.fontSize;
    let bold = first.bold;
    let italic = first.italic;
    for (const span of spans) {
      x = Math.min(x, span.x);
      right = Math.max(right, span.x + span.width);
      top = Math.min(top, span.top);
      height = Math.max(height, span.height);
      fontSize = Math.max(fontSize, span.fontSize);
      bold ||= span.bold;
      italic ||= span.italic;
    }
    const text = joinSpans(spans);
    if (!text) continue;
    output.push({
      page: page.number,
      spans,
      text,
      x,
      top,
      width: right - x,
      height,
      fontSize,
      fontId: first.fontId,
      ...(first.fontFamily ? { fontFamily: first.fontFamily } : {}),
      bold,
      italic,
    });
  }
  return output;
}

function joinSpans(spans: RawPdfTextSpan[]): string {
  let output = '';
  let previous: RawPdfTextSpan | undefined;
  for (const span of spans) {
    if (
      previous &&
      span.x - (previous.x + previous.width) >
        Math.max(previous.height * 0.25, 0.003)
    )
      output += ' ';
    output += span.text;
    previous = span;
  }
  return output.trim();
}

function byTop(left: PdfLine, right: PdfLine): number {
  return left.top - right.top || left.x - right.x;
}

async function analyseStyles(
  lines: readonly PdfLine[],
  mappings: Readonly<Record<string, StyleMapping>> | undefined,
  options: PdfAnalysisOptions,
): Promise<AnalysedStyle[]> {
  const bodySize = median(lines.map(({ fontSize }) => fontSize)) ?? 11;
  const grouped = new Map<string, PdfLine[]>();
  for (let index = 0; index < lines.length; index++) {
    if (index % 250 === 0) await analysisCheckpoint(options);
    const line = lines[index]!;
    const id = styleId(line);
    const group = grouped.get(id) ?? [];
    group.push(line);
    grouped.set(id, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, group]) => {
      const first = group[0]!;
      const inferred = inferredMapping(first, bodySize);
      const explicit = mappings?.[id];
      return {
        id,
        name: first.fontId,
        kind: 'paragraph',
        formatting: {
          ...(first.fontFamily ? { fontFamily: first.fontFamily } : {}),
          fontSizePt: first.fontSize,
          bold: first.bold,
          italic: first.italic,
        },
        usageCount: group.length,
        examples: group.slice(0, 3).map(({ text }) => text.slice(0, 120)),
        proposedMapping: explicit ?? inferred,
        reasons: explicit
          ? ['Applied the explicit user mapping.']
          : [
              'Compared PDF font size and emphasis with the dominant body text.',
            ],
        provenance: {
          source: 'pdf-layout-analysis',
          method: explicit ? 'user' : 'inferred',
          confidence: explicit ? 'certain' : 'medium',
        },
      };
    });
}

function inferredMapping(line: PdfLine, bodySize: number): StyleMapping {
  if (line.fontSize >= bodySize * 1.7) return 'heading1';
  if (line.fontSize >= bodySize * 1.4) return 'heading2';
  if (line.fontSize >= bodySize * 1.2 && line.bold) return 'heading3';
  return 'body';
}

function styleId(line: PdfLine): string {
  return [
    'pdf',
    line.fontId.replaceAll(/[^A-Za-z0-9_-]/g, '-'),
    Number(line.fontSize.toFixed(2)),
    line.bold ? 'bold' : 'regular',
    line.italic ? 'italic' : 'roman',
  ].join('-');
}

async function linesToBlocks(
  lines: readonly PdfLine[],
  styles: readonly AnalysedStyle[],
  pages: readonly RawPdfPage[],
  options: PdfAnalysisOptions,
): Promise<BlockNode[]> {
  const mapping = new Map(
    styles.map(({ id, proposedMapping }) => [id, proposedMapping]),
  );
  const blocks: BlockNode[] = [];
  let previousLine: PdfLine | undefined;
  let contentPages = 0;
  let processed = 0;
  for (const page of pages) {
    await analysisCheckpoint(options);
    const pageLines = lines.filter(
      ({ page: pageNumber }) => pageNumber === page.number,
    );
    const placements = imagePlacements(pageLines, page.images);
    if (pageLines.length === 0 && page.images.length === 0) continue;
    if (contentPages++ > 0) blocks.push({ type: 'pageBreak' });
    previousLine = undefined;
    for (let index = 0; index <= pageLines.length; index++) {
      for (const image of placements.get(index) ?? []) {
        blocks.push({ type: 'imageBlock', assetId: image.id });
        previousLine = undefined;
      }
      const line = pageLines[index];
      if (!line) continue;
      if (processed++ % 250 === 0) await analysisCheckpoint(options);
      const id = styleId(line);
      const mapped = mapping.get(id) ?? 'body';
      if (mapped !== 'ignore') {
        const children = lineInlines(line, page.links);
        const taggedRole = taggedRoleForLine(page.taggedStructure, line);
        const heading =
          /^H([1-6])$/i.exec(taggedRole ?? '') ??
          /^heading([1-6])$/.exec(mapped);
        const previousBlock = blocks.at(-1);
        if (
          !heading &&
          previousLine &&
          previousBlock?.type === 'paragraph' &&
          canMergeLines(previousLine, line) &&
          previousBlock.styleId === id
        ) {
          previousBlock.children.push({ type: 'text', text: ' ' }, ...children);
        } else {
          blocks.push(
            heading
              ? {
                  type: 'heading',
                  level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6,
                  children,
                  styleId: id,
                }
              : { type: 'paragraph', children, styleId: id },
          );
        }
      }
      previousLine = line;
    }
  }
  return blocks;
}

function imagePlacements(
  lines: readonly PdfLine[],
  images: readonly RawPdfImage[],
): Map<number, RawPdfImage[]> {
  const placements = new Map<number, RawPdfImage[]>();
  for (const image of [...images].sort(
    (left, right) => left.top - right.top || left.x - right.x,
  )) {
    const imageIsLeft = image.x + image.width / 2 < 0.5;
    const sameColumn = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          line.width >= 0.65 ||
          image.width >= 0.65 ||
          line.x + line.width / 2 < 0.5 === imageIsLeft,
      );
    const following = sameColumn.find(({ line }) => line.top >= image.top);
    const geometricIndex = lines.findIndex(({ top }) => top >= image.top);
    const index =
      following?.index ??
      (sameColumn.length > 0
        ? sameColumn[sameColumn.length - 1]!.index + 1
        : geometricIndex >= 0
          ? geometricIndex
          : lines.length);
    const group = placements.get(index) ?? [];
    group.push(image);
    placements.set(index, group);
  }
  return placements;
}

function lineInlines(
  line: PdfLine,
  links: readonly RawPdfLink[],
): InlineNode[] {
  const output: InlineNode[] = [];
  let previous: RawPdfTextSpan | undefined;
  for (const span of line.spans) {
    if (
      previous &&
      span.x - (previous.x + previous.width) >
        Math.max(previous.height * 0.25, 0.003)
    )
      output.push({ type: 'text', text: ' ' });
    const marks = [
      ...(span.bold ? ([{ type: 'bold' as const }] as const) : []),
      ...(span.italic ? ([{ type: 'italic' as const }] as const) : []),
    ];
    const text: InlineNode = {
      type: 'text',
      text: span.text,
      ...(marks.length > 0 ? { marks: [...marks] } : {}),
    };
    const link = span.linkId
      ? links.find(({ id }) => id === span.linkId)
      : undefined;
    output.push(
      link ? { type: 'link', href: link.href, children: [text] } : text,
    );
    previous = span;
  }
  return output;
}

function canMergeLines(previous: PdfLine, current: PdfLine): boolean {
  if (previous.page !== current.page || Math.abs(previous.x - current.x) > 0.04)
    return false;
  const gap = current.top - (previous.top + previous.height);
  return (
    gap >= -0.002 && gap <= Math.max(previous.height, current.height) * 0.8
  );
}

function taggedRoleForLine(
  root: RawPdfStructureNode | undefined,
  line: PdfLine,
): string | undefined {
  if (!root) return undefined;
  const ids = new Set(
    line.spans
      .map(({ markedContentId }) => markedContentId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const id of ids) {
    const role = taggedRole(root, id);
    if (role) return role;
  }
  return undefined;
}

function taggedRole(
  node: RawPdfStructureNode,
  markedContentId: string,
  semanticRole?: string,
): string | undefined {
  const role = node.role === 'NonStruct' ? semanticRole : node.role;
  if (node.markedContentId === markedContentId) return role;
  for (const child of node.children) {
    const found = taggedRole(child, markedContentId, role);
    if (found) return found;
  }
  return undefined;
}

async function detectFurniture(
  raw: RawPdfDocument,
  options: PdfAnalysisOptions,
): Promise<PdfFurnitureCandidate[]> {
  if (raw.pageCount < 4) return [];
  const groups = new Map<
    string,
    {
      normalized: string;
      kind: PdfFurnitureCandidate['kind'];
      lines: PdfLine[];
      pages: number[];
    }
  >();
  for (const page of raw.pages) {
    await analysisCheckpoint(options);
    for (const line of await groupLines(page, options)) {
      const kind = furnitureKind(line);
      if (!kind || !line.text.trim()) continue;
      const normalized = normalizeFurniture(line.text);
      const key = furnitureKey(line, page.number, kind);
      const group = groups.get(key) ?? {
        normalized,
        kind,
        lines: [],
        pages: [],
      };
      group.lines.push(line);
      group.pages.push(page.number);
      groups.set(key, group);
    }
  }
  const explicitlyRemoved = new Set(options.removedCandidateIds ?? []);
  const explicitlyRetained = new Set(options.retainedCandidateIds ?? []);
  return [...groups.entries()]
    .filter(([, group]) => new Set(group.pages).size >= 2)
    .map(([key, group]) => {
      const parity: PdfFurnitureCandidate['pageParity'] =
        group.pages[0]! % 2 === 0 ? 'even' : 'odd';
      const parityPages = raw.pages.filter(
        ({ number }) => (number % 2 === 0 ? 'even' : 'odd') === parity,
      ).length;
      const ratio = new Set(group.pages).size / Math.max(parityPages, 1);
      const confidence: PdfFurnitureCandidate['confidence'] =
        ratio >= 0.75 ? 'high' : ratio >= 0.5 ? 'medium' : 'low';
      const id = furnitureId(key);
      const removed =
        explicitlyRemoved.has(id) ||
        (!explicitlyRetained.has(id) &&
          options.removeDetectedFurniture !== false &&
          confidence === 'high');
      return {
        id,
        kind: group.kind,
        text: group.lines[0]?.text.trim() ?? '',
        normalizedText: group.normalized,
        pageParity: parity,
        pageNumbers: [...new Set(group.pages)].sort(
          (left, right) => left - right,
        ),
        confidence,
        removed,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function furnitureSpanIds(
  raw: RawPdfDocument,
  removedIds: ReadonlySet<string>,
  options: PdfAnalysisOptions,
): Promise<Set<string>> {
  const removed = new Set<string>();
  for (const page of raw.pages) {
    await analysisCheckpoint(options);
    for (const line of await groupLines(page, options)) {
      const kind = furnitureKind(line);
      if (
        kind &&
        removedIds.has(furnitureId(furnitureKey(line, page.number, kind)))
      )
        for (const span of line.spans) removed.add(span.id);
    }
  }
  return removed;
}

function furnitureKind(
  line: PdfLine,
): PdfFurnitureCandidate['kind'] | undefined {
  if (line.top <= FURNITURE_BAND) return 'header';
  if (line.top + line.height < 1 - FURNITURE_BAND) return undefined;
  return isPageNumber(line.text) ? 'page-number' : 'footer';
}

function furnitureKey(
  line: PdfLine,
  pageNumber: number,
  kind: PdfFurnitureCandidate['kind'],
): string {
  const parity = pageNumber % 2 === 0 ? 'even' : 'odd';
  const alignment =
    line.x < 0.33 ? 'left' : line.x + line.width > 0.67 ? 'right' : 'center';
  return [
    kind,
    parity,
    alignment,
    Math.round(line.top * 20),
    line.fontId,
    Math.round(line.fontSize),
    normalizeFurniture(line.text),
  ].join('|');
}

function furnitureId(key: string): string {
  return `pdf-furniture-${hash(key)}`;
}

async function analysisCheckpoint(options: PdfAnalysisOptions): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (options.cancellation?.cancelled)
    throw new PdfReadError('cancelled', 'The operation was cancelled.', {
      phase: 'analyse',
      recoverable: true,
    });
}

function normalizeFurniture(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase('en')
    .replace(/\bpage\s+\d+\s+of\s+\d+\b/g, 'page # of #')
    .replace(/^\s*[-–—]?\s*\d+\s*[-–—]?\s*$/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
}

function isPageNumber(text: string): boolean {
  return /^(?:\s*[-–—]?\s*\d+\s*[-–—]?\s*|page\s+\d+(?:\s+of\s+\d+)?)$/i.test(
    text.trim(),
  );
}

function hash(value: string): string {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return undefined;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? value) + value) / 2
    : value;
}

function metadata(
  raw: RawPdfDocument,
  options: PdfAnalysisOptions,
): DocumentMetadata {
  const extracted = (location: string): Provenance => ({
    source: 'pdf-metadata',
    location,
    method: 'extracted',
    confidence: 'high',
  });
  const inferred = (reason: string): Provenance => ({
    source: 'pdf-layout-analysis',
    method: 'inferred',
    confidence: 'medium',
    reason,
  });
  const value = <T>(entry: T, provenance: Provenance): InferredValue<T> => ({
    value: entry,
    provenance,
  });
  const firstLine = raw.pages
    .flatMap(({ spans }) => spans)
    .filter(({ text }) => text.trim())
    .sort((left, right) => right.fontSize - left.fontSize)[0]
    ?.text.trim();
  const filenameTitle = options.filename
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.pdf$/i, '')
    .trim();
  const title = raw.metadata.title?.trim() || firstLine || filenameTitle;
  const author = raw.metadata.author?.trim();
  const authors: InferredValue<Person>[] = author
    ? [value({ name: author }, extracted('document-info:Author'))]
    : [];
  return {
    ...(title
      ? {
          title: value(
            title,
            raw.metadata.title
              ? extracted('document-info:Title')
              : inferred(
                  'Selected the largest text near the start of the PDF.',
                ),
          ),
        }
      : {}),
    authors,
    ...(raw.metadata.language
      ? {
          language: value(raw.metadata.language, extracted('catalog:Lang')),
        }
      : {}),
    ...(raw.metadata.subject
      ? {
          description: value(
            raw.metadata.subject,
            extracted('document-info:Subject'),
          ),
        }
      : {}),
    subjects: (raw.metadata.keywords ?? []).map((keyword) =>
      value(keyword, extracted('document-info:Keywords')),
    ),
    ...(raw.metadata.createdAt
      ? {
          sourceCreatedAt: value(
            raw.metadata.createdAt,
            extracted('document-info:CreationDate'),
          ),
        }
      : {}),
    ...(raw.metadata.modifiedAt
      ? {
          sourceModifiedAt: value(
            raw.metadata.modifiedAt,
            extracted('document-info:ModDate'),
          ),
        }
      : {}),
    conversionDate: value(options.conversionDate, {
      source: 'conversion-options',
      method: 'user',
      confidence: 'certain',
    }),
  };
}
