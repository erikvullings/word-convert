import type {
  BlockNode,
  DocumentModel,
  InlineNode,
  TextMark,
} from '@wordconvert/document-model';
import { writeMarkdown } from '@wordconvert/markdown-writer';
import { Lexer, type Token, type Tokens } from 'marked';

export interface ContentPartState {
  starts: number[];
  activeIndex: number;
}

function decodedEquationId(
  encoded: string,
  model: DocumentModel,
): string | undefined {
  try {
    const id = decodeURIComponent(encoded);
    return model.equations[id] ? id : undefined;
  } catch (cause) {
    if (cause instanceof URIError) return undefined;
    throw cause;
  }
}

export interface ContentPartSummary {
  start: number;
  end: number;
  title: string;
}

function isCaptionParagraph(
  original: readonly InlineNode[],
  candidate: readonly InlineNode[],
): boolean {
  const unwrapped = withoutItalicWrapper(candidate);
  return (
    inlineIdentity(original) === inlineIdentity(unwrapped) ||
    isFullyItalicized(candidate)
  );
}

function isFullyItalicized(nodes: readonly InlineNode[]): boolean {
  const textNodes = nodes.flatMap((node): InlineNode[] =>
    node.type === 'link' ? node.children : [node],
  );
  const meaningfulText = textNodes.filter(
    (node) => node.type === 'text' && node.text.trim().length > 0,
  );
  return (
    meaningfulText.length > 0 &&
    meaningfulText.every(
      (node) =>
        node.type === 'text' &&
        node.marks?.some((mark) => mark.type === 'italic'),
    )
  );
}

export interface ContentPartSplitHeading {
  blockOffset: number;
  title: string;
}

const MINIMUM_PART_BLOCKS = 3;

export function createContentPartState(
  model: Pick<DocumentModel, 'blocks'>,
): ContentPartState {
  return createHeadingContentPartState(model, 1);
}

function createHeadingContentPartState(
  model: Pick<DocumentModel, 'blocks'>,
  maximumLevel: number,
): ContentPartState {
  const starts = [
    0,
    ...model.blocks.flatMap((block, index) =>
      index > 0 && block.type === 'heading' && block.level <= maximumLevel
        ? [index]
        : [],
    ),
  ];
  return { starts, activeIndex: 0 };
}

export function createPracticalContentPartState(
  model: Pick<DocumentModel, 'blocks'>,
): ContentPartState {
  return normalizeContentPartState(
    model,
    createHeadingContentPartState(model, 2),
  );
}

export function normalizeContentPartState(
  model: Pick<DocumentModel, 'blocks'>,
  state: ContentPartState,
): ContentPartState {
  const activeStart = state.starts[state.activeIndex] ?? 0;
  const starts = [...state.starts];
  while (starts.length > 1) {
    const tinyIndex = starts.findIndex((start, index) => {
      const end = starts[index + 1] ?? model.blocks.length;
      return (
        visibleBlockCount(model.blocks.slice(start, end)) < MINIMUM_PART_BLOCKS
      );
    });
    if (tinyIndex < 0) break;
    starts.splice(tinyIndex === 0 ? 1 : tinyIndex, 1);
  }
  const activeIndex = Math.max(
    0,
    starts.findLastIndex((start) => start <= activeStart),
  );
  return { starts, activeIndex };
}

export function contentPartSummaries(
  model: Pick<DocumentModel, 'blocks'>,
  state: ContentPartState,
): ContentPartSummary[] {
  return state.starts.map((start, index) => {
    const end = state.starts[index + 1] ?? model.blocks.length;
    const heading = model.blocks
      .slice(start, end)
      .find((block) => block.type === 'heading');
    return {
      start,
      end,
      title:
        heading?.type === 'heading'
          ? inlineText(heading.children) || `Part ${index + 1}`
          : index === 0 && state.starts.length > 1
            ? 'Front matter'
            : `Part ${index + 1}`,
    };
  });
}

export function contentPartModel(
  model: DocumentModel,
  state: ContentPartState,
): DocumentModel {
  const start = state.starts[state.activeIndex] ?? 0;
  const end = state.starts[state.activeIndex + 1] ?? model.blocks.length;
  return { ...model, blocks: model.blocks.slice(start, end) };
}

export function contentEditorSource(model: DocumentModel): string {
  const metadata = { ...model.metadata };
  delete metadata.title;
  return annotateEquationReferences(
    writeMarkdown(
      { ...model, metadata },
      {
        conversionDate: model.metadata.conversionDate.value,
        formulaMode: 'source',
      },
    ),
    model,
  );
}

export function unsupportedContentImageSources(
  markdown: string,
  model: DocumentModel,
): string[] {
  const allowed = new Set(assetUrls(model).keys());
  return [
    ...new Set(
      collectImageSources(Lexer.lex(markdown)).filter(
        (source) => !allowed.has(source),
      ),
    ),
  ];
}

interface ContentImageImportLimits {
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
}

type ContentImageImportResult =
  | { ok: true; model: DocumentModel; markdown: string }
  | {
      ok: false;
      reason:
        | 'invalid-image'
        | 'image-too-large'
        | 'too-many-images'
        | 'images-too-large';
      message: string;
    };

const DEFAULT_CONTENT_IMAGE_LIMITS: ContentImageImportLimits = {
  maxImages: 100,
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};
type ContentImageMediaType =
  'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
const CONTENT_IMAGE_MEDIA_EXTENSIONS = new Map<ContentImageMediaType, string>([
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
] as const);

export function importContentDataImages(
  markdown: string,
  model: DocumentModel,
  limits: ContentImageImportLimits = DEFAULT_CONTENT_IMAGE_LIMITS,
): ContentImageImportResult {
  const assetsByUrl = new Map(assetUrls(model));
  const assets = { ...model.assets };
  const replacements = new Map<string, string>();
  let imageCount = Object.keys(assets).filter((id) =>
    id.startsWith('editor-image-'),
  ).length;
  let totalBytes = Object.values(assets)
    .filter((asset) => asset.id.startsWith('editor-image-'))
    .reduce((total, asset) => total + asset.data.byteLength, 0);
  let nextImageNumber = 1;

  for (const source of new Set(collectImageSources(Lexer.lex(markdown)))) {
    if (
      assetsByUrl.has(source) ||
      !source.toLowerCase().startsWith('data:image/')
    )
      continue;
    const parsed = parseContentImageDataUri(source, limits.maxImageBytes);
    if (!parsed.ok) return parsed;
    const canonicalSource = `data:${parsed.mediaType};base64,${base64(parsed.data)}`;
    replacements.set(source, canonicalSource);
    if (assetsByUrl.has(canonicalSource)) continue;
    if (imageCount >= limits.maxImages)
      return {
        ok: false,
        reason: 'too-many-images',
        message: `A book can contain at most ${limits.maxImages} images inserted from Markdown.`,
      };
    if (totalBytes + parsed.data.byteLength > limits.maxTotalBytes)
      return {
        ok: false,
        reason: 'images-too-large',
        message: 'Images inserted from Markdown exceed the total size limit.',
      };
    let id = `editor-image-${String(nextImageNumber).padStart(4, '0')}`;
    while (assets[id]) {
      nextImageNumber += 1;
      id = `editor-image-${String(nextImageNumber).padStart(4, '0')}`;
    }
    const extension = CONTENT_IMAGE_MEDIA_EXTENSIONS.get(parsed.mediaType);
    assets[id] = {
      id,
      mediaType: parsed.mediaType,
      data: parsed.data,
      filename: `${id}.${extension}`,
    };
    assetsByUrl.set(canonicalSource, id);
    imageCount += 1;
    totalBytes += parsed.data.byteLength;
    nextImageNumber += 1;
  }

  const normalizedMarkdown = [...replacements].reduce(
    (content, [source, replacement]) => content.split(source).join(replacement),
    markdown,
  );
  return {
    ok: true,
    model:
      Object.keys(assets).length === Object.keys(model.assets).length
        ? model
        : { ...model, assets },
    markdown: normalizedMarkdown,
  };
}

function parseContentImageDataUri(
  source: string,
  maxImageBytes: number,
):
  | {
      ok: true;
      mediaType: ContentImageMediaType;
      data: Uint8Array;
    }
  | Extract<ContentImageImportResult, { ok: false }> {
  const comma = source.indexOf(',');
  const mediaType = source
    .slice(5, comma)
    .replace(/;base64$/i, '')
    .toLowerCase();
  const encoded = source.slice(comma + 1);
  if (
    comma < 0 ||
    !/;base64$/i.test(source.slice(0, comma)) ||
    !CONTENT_IMAGE_MEDIA_EXTENSIONS.has(mediaType as ContentImageMediaType) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
    encoded.length % 4 === 1
  )
    return invalidContentImage();
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (Math.floor((encoded.length * 3) / 4) - padding > maxImageBytes)
    return {
      ok: false,
      reason: 'image-too-large',
      message: 'An image inserted from Markdown exceeds the size limit.',
    };
  let data: Uint8Array;
  try {
    const binary = atob(encoded);
    data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalidContentImage();
  }
  if (
    data.byteLength > maxImageBytes ||
    !hasContentImageSignature(mediaType, data)
  )
    return data.byteLength > maxImageBytes
      ? {
          ok: false,
          reason: 'image-too-large',
          message: 'An image inserted from Markdown exceeds the size limit.',
        }
      : invalidContentImage();
  return {
    ok: true,
    mediaType: mediaType as ContentImageMediaType,
    data,
  };
}

function invalidContentImage(): Extract<
  ContentImageImportResult,
  { ok: false }
> {
  return {
    ok: false,
    reason: 'invalid-image',
    message:
      'Inserted images must be valid base64-encoded AVIF, GIF, JPEG, PNG, or WebP data URIs.',
  };
}

function hasContentImageSignature(
  mediaType: string,
  data: Uint8Array,
): boolean {
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...data.subarray(start, end));
  if (mediaType === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => data[index] === byte,
    );
  if (mediaType === 'image/jpeg')
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mediaType === 'image/gif')
    return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (mediaType === 'image/webp')
    return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  return (
    mediaType === 'image/avif' &&
    ascii(4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(ascii(8, 12))
  );
}

function collectImageSources(tokens: readonly Token[]): string[] {
  return tokens.flatMap((token) => {
    const current =
      token.type === 'image' ? [(token as Tokens.Image).href] : [];
    const nested =
      'tokens' in token && Array.isArray(token.tokens)
        ? collectImageSources(token.tokens)
        : [];
    const items =
      'items' in token && Array.isArray(token.items)
        ? token.items.flatMap((item) =>
            'tokens' in item && Array.isArray(item.tokens)
              ? collectImageSources(item.tokens)
              : [],
          )
        : [];
    const tableCells =
      token.type === 'table'
        ? [
            ...(token as Tokens.Table).header,
            ...(token as Tokens.Table).rows.flat(),
          ].flatMap((cell) => collectImageSources(cell.tokens))
        : [];
    return [...current, ...nested, ...items, ...tableCells];
  });
}

export function saveContentPart(
  model: DocumentModel,
  state: ContentPartState,
  markdown: string,
): { model: DocumentModel; state: ContentPartState } {
  const start = state.starts[state.activeIndex] ?? 0;
  const end = state.starts[state.activeIndex + 1] ?? model.blocks.length;
  const original = model.blocks.slice(start, end);
  const replacement = restoreBlockSemantics(
    original,
    markdownToBlocks(markdown, model),
  );
  const delta = replacement.length - (end - start);
  return {
    model: {
      ...model,
      blocks: [
        ...model.blocks.slice(0, start),
        ...replacement,
        ...model.blocks.slice(end),
      ],
    },
    state: {
      activeIndex: state.activeIndex,
      starts: state.starts.map((partStart, index) =>
        index > state.activeIndex ? partStart + delta : partStart,
      ),
    },
  };
}

export function mergeContentPart(
  model: DocumentModel,
  state: ContentPartState,
  direction: 'previous' | 'next',
): { model: DocumentModel; state: ContentPartState } | undefined {
  const boundaryIndex =
    direction === 'previous' ? state.activeIndex : state.activeIndex + 1;
  if (boundaryIndex <= 0 || boundaryIndex >= state.starts.length)
    return undefined;
  return {
    model,
    state: {
      starts: state.starts.filter((_, index) => index !== boundaryIndex),
      activeIndex:
        direction === 'previous' ? state.activeIndex - 1 : state.activeIndex,
    },
  };
}

export function deleteContentPart(
  model: DocumentModel,
  state: ContentPartState,
): { model: DocumentModel; state: ContentPartState } | undefined {
  if (state.starts.length <= 1) return undefined;
  const start = state.starts[state.activeIndex] ?? 0;
  const end = state.starts[state.activeIndex + 1] ?? model.blocks.length;
  const removed = end - start;
  const starts = state.starts
    .filter((_, index) => index !== state.activeIndex)
    .map((partStart) => (partStart >= end ? partStart - removed : partStart));
  return {
    model: {
      ...model,
      blocks: [...model.blocks.slice(0, start), ...model.blocks.slice(end)],
    },
    state: {
      starts,
      activeIndex: Math.min(state.activeIndex, starts.length - 1),
    },
  };
}

export function splitContentPart(
  model: DocumentModel,
  state: ContentPartState,
  blockOffset: number,
): { model: DocumentModel; state: ContentPartState } | undefined {
  const start = state.starts[state.activeIndex] ?? 0;
  const end = state.starts[state.activeIndex + 1] ?? model.blocks.length;
  const splitAt = start + blockOffset;
  const block = model.blocks[splitAt];
  if (
    blockOffset <= 0 ||
    splitAt >= end ||
    block?.type !== 'heading' ||
    block.level !== 2 ||
    visibleBlockCount(model.blocks.slice(start, splitAt)) <
      MINIMUM_PART_BLOCKS ||
    visibleBlockCount(model.blocks.slice(splitAt, end)) < MINIMUM_PART_BLOCKS
  )
    return undefined;
  return {
    model,
    state: {
      starts: [
        ...state.starts.slice(0, state.activeIndex + 1),
        splitAt,
        ...state.starts.slice(state.activeIndex + 1),
      ],
      activeIndex: state.activeIndex + 1,
    },
  };
}

function visibleBlockCount(blocks: readonly BlockNode[]): number {
  return blocks.reduce((count, block) => {
    if (block.type === 'pageBreak') return count;
    const lineBreaks =
      block.type === 'heading' || block.type === 'paragraph'
        ? block.children.filter((child) => child.type === 'lineBreak').length
        : 0;
    return count + 1 + lineBreaks;
  }, 0);
}

export function contentPartSplitHeadings(
  model: Pick<DocumentModel, 'blocks'>,
  state: ContentPartState,
): ContentPartSplitHeading[] {
  const start = state.starts[state.activeIndex] ?? 0;
  const end = state.starts[state.activeIndex + 1] ?? model.blocks.length;
  return model.blocks
    .slice(start + 1, end)
    .flatMap((block, index) =>
      block.type === 'heading' &&
      block.level === 2 &&
      visibleBlockCount(model.blocks.slice(start, start + index + 1)) >=
        MINIMUM_PART_BLOCKS &&
      visibleBlockCount(model.blocks.slice(start + index + 1, end)) >=
        MINIMUM_PART_BLOCKS
        ? [{ blockOffset: index + 1, title: inlineText(block.children) }]
        : [],
    );
}

export function markdownToBlocks(
  markdown: string,
  model: DocumentModel,
): BlockNode[] {
  const assets = assetUrls(model);
  const editable = extractHeadingAnchors(
    replaceEquationSpans(withoutNoteDefinitions(markdown, model)),
  );
  return removePageBoundaryNoise(
    applyHeadingAnchors(
      blockTokens(Lexer.lex(editable.markdown, { gfm: true }), assets, model),
      editable.ids,
    ),
  );
}

function removePageBoundaryNoise(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.filter((block, index) => {
    if (block.type !== 'paragraph' || blocks[index + 1]?.type !== 'pageBreak')
      return true;
    const text = inlineText(block.children).trim();
    return text !== '\\' && text !== '**';
  });
}

function annotateEquationReferences(
  markdown: string,
  model: DocumentModel,
): string {
  let cursor = 0;
  let output = '';
  for (const reference of equationReferences(model.blocks)) {
    const equation = model.equations[reference.id];
    if (!equation) continue;
    const value = equation.tex ?? equation.mathml ?? equation.source.value;
    const source = reference.block ? `$$\n${value}\n$$` : `$${value}$`;
    const index = markdown.indexOf(source, cursor);
    if (index < 0) continue;
    output += markdown.slice(cursor, index);
    output += `<span data-wordconvert-equation-id="${encodeURIComponent(reference.id)}" data-wordconvert-display="${reference.block ? 'block' : 'inline'}">${source}</span>`;
    cursor = index + source.length;
  }
  return `${output}${markdown.slice(cursor)}`;
}

function equationReferences(
  blocks: readonly BlockNode[],
): { id: string; block: boolean }[] {
  const references: { id: string; block: boolean }[] = [];
  const collectInlines = (nodes: readonly InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'equation')
        references.push({ id: node.equationId, block: false });
      else if (node.type === 'link') collectInlines(node.children);
    }
  };
  const collectBlocks = (nodes: readonly BlockNode[]): void => {
    for (const block of nodes) {
      if (block.type === 'heading' || block.type === 'paragraph')
        collectInlines(block.children);
      else if (block.type === 'equationBlock')
        references.push({ id: block.equationId, block: true });
      else if (block.type === 'blockquote') collectBlocks(block.blocks);
      else if (block.type === 'list')
        for (const item of block.items) collectBlocks(item.blocks);
      else if (block.type === 'table') {
        if (block.caption) collectInlines(block.caption);
        for (const row of block.rows)
          for (const cell of row.cells) collectBlocks(cell.blocks);
      } else if (block.type === 'imageBlock' && block.caption)
        collectInlines(block.caption);
    }
  };
  collectBlocks(blocks);
  return references;
}

function replaceEquationSpans(markdown: string): string {
  return markdown.replace(
    /<span data-wordconvert-equation-id="([^"]+)" data-wordconvert-display="(inline|block)">[\s\S]*?<\/span>/g,
    (_match, encodedId: string, display: string) =>
      display === 'block'
        ? `[wordconvert-equation-block:${encodedId}]`
        : `[wordconvert-equation:${encodedId}]`,
  );
}

function extractHeadingAnchors(markdown: string): {
  markdown: string;
  ids: (string | undefined)[];
} {
  const output: string[] = [];
  const ids: (string | undefined)[] = [];
  let pendingId: string | undefined;
  for (const line of markdown.split('\n')) {
    const anchor = /^<a\s+id="([^"]+)"[^>]*><\/a>\s*$/i.exec(line.trim());
    if (anchor?.[1]) {
      pendingId = decodeHtmlAttribute(anchor[1]);
      continue;
    }
    if (/^ {0,3}#{1,6}\s/.test(line)) {
      ids.push(pendingId);
      pendingId = undefined;
    }
    output.push(line);
  }
  return { markdown: output.join('\n'), ids };
}

function applyHeadingAnchors(
  blocks: BlockNode[],
  ids: readonly (string | undefined)[],
): BlockNode[] {
  let headingIndex = 0;
  return blocks.map((block) => {
    if (block.type !== 'heading') return block;
    const id = ids[headingIndex++];
    return id ? { ...block, id } : block;
  });
}

export function withMarkdownContent(
  model: DocumentModel,
  markdown: string,
): DocumentModel {
  return { ...model, blocks: markdownToBlocks(markdown, model) };
}

function blockTokens(
  tokens: readonly Token[],
  assets: ReadonlyMap<string, string>,
  model: DocumentModel,
): BlockNode[] {
  return tokens.flatMap((token): BlockNode[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [
          {
            type: 'heading',
            level: Math.min(6, Math.max(1, heading.depth)) as
              1 | 2 | 3 | 4 | 5 | 6,
            children: inlineTokens(heading.tokens, assets, model),
          },
        ];
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph;
        const equationId = blockEquationId(paragraph.raw, model);
        if (equationId) return [{ type: 'equationBlock', equationId }];
        return [
          {
            type: 'paragraph',
            children: inlineTokens(paragraph.tokens, assets, model),
          },
        ];
      }
      case 'text': {
        const text = token as Tokens.Text;
        return [
          {
            type: 'paragraph',
            children: inlineTokens(
              text.tokens ?? [{ type: 'text', raw: text.raw, text: text.text }],
              assets,
              model,
            ),
          },
        ];
      }
      case 'list': {
        const list = token as Tokens.List;
        return [
          {
            type: 'list',
            ordered: list.ordered,
            ...(list.ordered && list.start !== '' ? { start: list.start } : {}),
            items: list.items.map((item) => ({
              blocks: blockTokens(item.tokens, assets, model),
            })),
          },
        ];
      }
      case 'blockquote':
        return [
          {
            type: 'blockquote',
            blocks: blockTokens(
              (token as Tokens.Blockquote).tokens,
              assets,
              model,
            ),
          },
        ];
      case 'code': {
        const code = token as Tokens.Code;
        return [
          {
            type: 'codeBlock',
            text: code.text,
            ...(code.lang?.trim() ? { language: code.lang.trim() } : {}),
          },
        ];
      }
      case 'hr':
        return [{ type: 'thematicBreak' }];
      case 'table': {
        const table = token as Tokens.Table;
        return [
          {
            type: 'table',
            rows: [table.header, ...table.rows].map((row, rowIndex) => ({
              cells: row.map((cell) => ({
                header: rowIndex === 0,
                blocks: [
                  {
                    type: 'paragraph',
                    children: inlineTokens(cell.tokens, assets, model),
                  },
                ],
              })),
            })),
          },
        ];
      }
      case 'html': {
        const html = (token as Tokens.HTML).text;
        if (html.trim() === '<!-- markdown:page-break -->')
          return [{ type: 'pageBreak' }];
        const image = htmlImage(html, assets);
        return image
          ? [{ type: 'paragraph', children: [image] }]
          : htmlAnchor(html)
            ? []
            : [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: html }],
                },
              ];
      }
      default:
        return [];
    }
  });
}

function inlineTokens(
  tokens: readonly Token[],
  assets: ReadonlyMap<string, string>,
  model: DocumentModel,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  const htmlMarks: TextMark[] = [];
  for (const token of tokens) {
    if (token.type === 'html') {
      const tag = inlineMarkTag((token as Tokens.HTML).text);
      if (tag?.opening) {
        htmlMarks.push({ type: tag.type });
        continue;
      }
      if (tag) {
        const index = htmlMarks.findLastIndex((mark) => mark.type === tag.type);
        if (index >= 0) htmlMarks.splice(index, 1);
        continue;
      }
    }
    let parsed: InlineNode[];
    switch (token.type) {
      case 'text':
      case 'escape':
        parsed = semanticText((token as Tokens.Text).text, model);
        break;
      case 'strong':
        parsed = withMark(
          inlineTokens((token as Tokens.Strong).tokens, assets, model),
          {
            type: 'bold',
          },
        );
        break;
      case 'em':
        parsed = withMark(
          inlineTokens((token as Tokens.Em).tokens, assets, model),
          {
            type: 'italic',
          },
        );
        break;
      case 'del':
        parsed = withMark(
          inlineTokens((token as Tokens.Del).tokens, assets, model),
          {
            type: 'strikethrough',
          },
        );
        break;
      case 'codespan':
        parsed = [
          {
            type: 'text',
            text: (token as Tokens.Codespan).text,
            marks: [{ type: 'code' }],
          },
        ];
        break;
      case 'link': {
        const link = token as Tokens.Link;
        parsed = [
          {
            type: 'link',
            href: link.href,
            children: inlineTokens(link.tokens, assets, model),
            ...(link.title ? { title: link.title } : {}),
          },
        ];
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        const assetId = assets.get(image.href);
        parsed = assetId
          ? [
              {
                type: 'image',
                assetId,
                ...(image.text ? { alt: image.text } : {}),
                ...(image.title ? { title: image.title } : {}),
              },
            ]
          : [{ type: 'text', text: image.text }];
        break;
      }
      case 'br':
        parsed = [{ type: 'lineBreak' }];
        break;
      case 'html': {
        const image = htmlImage((token as Tokens.HTML).text, assets);
        parsed = image
          ? [image]
          : [{ type: 'text', text: (token as Tokens.HTML).text }];
        break;
      }
      default:
        parsed = [];
    }
    nodes.push(
      ...htmlMarks.reduce((marked, mark) => withMark(marked, mark), parsed),
    );
  }
  return nodes;
}

function inlineMarkTag(value: string):
  | {
      type: 'underline' | 'subscript' | 'superscript';
      opening: boolean;
    }
  | undefined {
  const match = /^<\s*(\/)?\s*(u|sub|sup)\s*>$/i.exec(value.trim());
  const name = match?.[2]?.toLowerCase();
  if (!name) return undefined;
  return {
    type:
      name === 'u' ? 'underline' : name === 'sub' ? 'subscript' : 'superscript',
    opening: match?.[1] === undefined,
  };
}

function withMark(nodes: InlineNode[], mark: TextMark): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'text')
      return { ...node, marks: [...(node.marks ?? []), mark] };
    if (node.type === 'link')
      return { ...node, children: withMark(node.children, mark) };
    return node;
  });
}

function withoutNoteDefinitions(
  markdown: string,
  model: DocumentModel,
): string {
  const labels = new Set(
    Object.keys(model.notes).map((id) => markdownLabel(id)),
  );
  const lines = markdown.split('\n');
  const firstDefinition = lines.findIndex((line) => {
    const match = /^\[\^([^\]]+)\]:/.exec(line);
    return match?.[1] !== undefined && labels.has(match[1]);
  });
  return firstDefinition < 0
    ? markdown
    : lines.slice(0, firstDefinition).join('\n').trimEnd();
}

function semanticText(value: string, model: DocumentModel): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern =
    /\[wordconvert-equation:([^\]]+)\]|\[\^([^\]]+)\]|\$((?:\\.|[^$\\\n])+)\$/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > offset)
      nodes.push({ type: 'text', text: value.slice(offset, index) });
    const stableEquationId =
      match[1] === undefined ? undefined : decodedEquationId(match[1], model);
    const noteId =
      match[2] === undefined
        ? undefined
        : Object.keys(model.notes).find(
            (candidate) => markdownLabel(candidate) === match[2],
          );
    const equationId =
      match[3] === undefined ? undefined : equationIdFor(match[3], model);
    if (stableEquationId)
      nodes.push({ type: 'equation', equationId: stableEquationId });
    else if (noteId) nodes.push({ type: 'noteReference', noteId });
    else if (equationId) nodes.push({ type: 'equation', equationId });
    else nodes.push({ type: 'text', text: match[0] });
    offset = index + match[0].length;
  }
  if (offset < value.length)
    nodes.push({ type: 'text', text: value.slice(offset) });
  return nodes.length > 0 ? nodes : [{ type: 'text', text: value }];
}

function blockEquationId(
  value: string,
  model: DocumentModel,
): string | undefined {
  const stable = /^\[wordconvert-equation-block:([^\]]+)\]$/.exec(value.trim());
  if (stable?.[1]) return decodedEquationId(stable[1], model);
  const match = /^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$$/.exec(value.trim());
  return match?.[1] === undefined
    ? undefined
    : equationIdFor(match[1].trim(), model);
}

function equationIdFor(
  value: string,
  model: DocumentModel,
): string | undefined {
  return Object.values(model.equations).find(
    (equation) =>
      (equation.tex ?? equation.mathml ?? equation.source.value) === value,
  )?.id;
}

function markdownLabel(value: string): string {
  return (
    value
      .replace(/_/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

function htmlAnchor(value: string): boolean {
  return /^<a\s+[^>]*id="[^"]*"[^>]*><\/a>\s*$/i.test(value.trim());
}

function htmlImage(
  value: string,
  assets: ReadonlyMap<string, string>,
): Extract<InlineNode, { type: 'image' }> | undefined {
  if (!/^<img\s/i.test(value.trim())) return undefined;
  const attributes = new Map<string, string>();
  for (const match of value.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi))
    if (match[1] && match[2] !== undefined)
      attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2]));
  const src = attributes.get('src');
  const assetId = src ? assets.get(src) : undefined;
  if (!assetId) return undefined;
  const alt = attributes.get('alt');
  const title = attributes.get('title');
  return {
    type: 'image',
    assetId,
    ...(alt ? { alt } : {}),
    ...(title ? { title } : {}),
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function restoreBlockSemantics(
  original: readonly BlockNode[],
  parsed: readonly BlockNode[],
): BlockNode[] {
  const restored: BlockNode[] = [];
  let originalIndex = 0;
  let parsedIndex = 0;
  while (originalIndex < original.length && parsedIndex < parsed.length) {
    const originalBlock = original[originalIndex];
    const parsedBlock = parsed[parsedIndex];
    if (!originalBlock || !parsedBlock) break;
    if (originalBlock.type === 'pageBreak') {
      restored.push(originalBlock);
      originalIndex += 1;
      continue;
    }
    if (
      originalBlock.type === 'imageBlock' &&
      parsedBlock.type === 'paragraph'
    ) {
      const image = singleImage(parsedBlock);
      if (image && image.assetId === originalBlock.assetId) {
        const captionBlock = parsed[parsedIndex + 1];
        const caption =
          originalBlock.caption &&
          captionBlock?.type === 'paragraph' &&
          isCaptionParagraph(originalBlock.caption, captionBlock.children)
            ? restoreInlineSemantics(
                originalBlock.caption,
                withoutItalicWrapper(captionBlock.children),
              )
            : undefined;
        const restoredImage: BlockNode = {
          ...originalBlock,
          ...(image.alt ? { alt: image.alt } : {}),
        };
        if (caption && restoredImage.type === 'imageBlock')
          restoredImage.caption = caption;
        else if (restoredImage.type === 'imageBlock')
          delete restoredImage.caption;
        restored.push(restoredImage);
        originalIndex += 1;
        parsedIndex += caption ? 2 : 1;
        continue;
      }
    }
    if (
      originalBlock.type === 'table' &&
      originalBlock.caption &&
      parsedBlock.type === 'paragraph' &&
      isCaptionParagraph(originalBlock.caption, parsedBlock.children) &&
      parsed[parsedIndex + 1]?.type === 'table'
    ) {
      const restoredTable = restoreBlock(
        originalBlock,
        parsed[parsedIndex + 1] as Extract<BlockNode, { type: 'table' }>,
      );
      if (restoredTable.type === 'table')
        restored.push({
          ...restoredTable,
          caption: restoreInlineSemantics(
            originalBlock.caption,
            withoutItalicWrapper(parsedBlock.children),
          ),
        });
      originalIndex += 1;
      parsedIndex += 2;
      continue;
    }
    if (
      originalBlock.type === parsedBlock.type &&
      sameBlockIdentity(originalBlock, parsedBlock)
    ) {
      restored.push(restoreBlock(originalBlock, parsedBlock));
      originalIndex += 1;
      parsedIndex += 1;
      continue;
    }
    const parsedIdentityLookahead = parsed
      .slice(parsedIndex + 1)
      .findIndex((block) => sameBlockIdentity(originalBlock, block));
    const originalIdentityLookahead = original
      .slice(originalIndex + 1)
      .findIndex((block) => sameBlockIdentity(block, parsedBlock));
    if (
      parsedIdentityLookahead >= 0 &&
      (originalIdentityLookahead < 0 ||
        parsedIdentityLookahead <= originalIdentityLookahead)
    ) {
      restored.push(parsedBlock);
      parsedIndex += 1;
      continue;
    }
    if (originalIdentityLookahead >= 0) {
      originalIndex += 1;
      continue;
    }
    if (originalBlock.type === parsedBlock.type) {
      restored.push(restoreBlock(originalBlock, parsedBlock));
      originalIndex += 1;
      parsedIndex += 1;
      continue;
    }
    const originalLookahead = original
      .slice(originalIndex + 1)
      .findIndex((block) => block.type === parsedBlock.type);
    const parsedLookahead = parsed
      .slice(parsedIndex + 1)
      .findIndex((block) => block.type === originalBlock.type);
    if (
      originalLookahead >= 0 &&
      (parsedLookahead < 0 || originalLookahead <= parsedLookahead)
    ) {
      originalIndex += 1;
    } else {
      restored.push(parsedBlock);
      parsedIndex += 1;
    }
  }
  while (originalIndex < original.length) {
    const block = original[originalIndex++];
    if (block?.type === 'pageBreak') restored.push(block);
  }
  restored.push(...parsed.slice(parsedIndex));
  return restored;
}

function restoreBlock(original: BlockNode, parsed: BlockNode): BlockNode {
  if (original.type !== parsed.type) return parsed;
  switch (original.type) {
    case 'heading':
      return parsed.type === 'heading'
        ? {
            ...parsed,
            ...(original.id ? { id: original.id } : {}),
            ...(original.numbering ? { numbering: original.numbering } : {}),
            ...(original.styleId ? { styleId: original.styleId } : {}),
            children: restoreInlineSemantics(
              original.children,
              withoutHeadingNumber(parsed.children, original.numbering),
            ),
          }
        : parsed;
    case 'paragraph':
      return parsed.type === 'paragraph'
        ? {
            ...parsed,
            ...(original.styleId ? { styleId: original.styleId } : {}),
            children: restoreInlineSemantics(
              original.children,
              parsed.children,
            ),
          }
        : parsed;
    case 'blockquote':
      return parsed.type === 'blockquote'
        ? {
            ...parsed,
            blocks: restoreBlockSemantics(original.blocks, parsed.blocks),
          }
        : parsed;
    case 'list':
      return parsed.type === 'list'
        ? {
            ...parsed,
            items: parsed.items.map((item, index) => ({
              blocks: restoreBlockSemantics(
                original.items[index]?.blocks ?? [],
                item.blocks,
              ),
            })),
          }
        : parsed;
    case 'table':
      return parsed.type === 'table'
        ? {
            ...parsed,
            rows: parsed.rows.map((row, rowIndex) => ({
              cells: row.cells.map((cell, cellIndex) => {
                const originalCell = original.rows[rowIndex]?.cells[cellIndex];
                if (!originalCell) return cell;
                const {
                  header: _header,
                  colSpan: _colSpan,
                  rowSpan: _rowSpan,
                  ...parsedCell
                } = cell;
                return {
                  ...parsedCell,
                  ...(originalCell.header !== undefined
                    ? { header: originalCell.header }
                    : {}),
                  ...(originalCell.colSpan !== undefined
                    ? { colSpan: originalCell.colSpan }
                    : {}),
                  ...(originalCell.rowSpan !== undefined
                    ? { rowSpan: originalCell.rowSpan }
                    : {}),
                  blocks: restoreBlockSemantics(
                    originalCell.blocks,
                    cell.blocks,
                  ),
                };
              }),
            })),
          }
        : parsed;
    case 'equationBlock':
      return parsed.type === 'equationBlock' ? original : parsed;
    default:
      return parsed;
  }
}

function restoreInlineSemantics(
  original: readonly InlineNode[],
  parsed: readonly InlineNode[],
): InlineNode[] {
  const textOnly = restoreTextMarkRanges(original, parsed);
  if (textOnly) return textOnly;
  return parsed.map((node, index) => {
    const source = original[index];
    if (
      node.type === 'image' &&
      source?.type === 'image' &&
      node.assetId === source.assetId
    )
      return {
        ...node,
        ...(source.presentation ? { presentation: source.presentation } : {}),
        ...(source.width !== undefined ? { width: source.width } : {}),
      };
    if (node.type === 'link' && source?.type === 'link')
      return {
        ...node,
        children: restoreInlineSemantics(source.children, node.children),
      };
    if (
      (node.type === 'equation' && source?.type === 'equation') ||
      (node.type === 'noteReference' && source?.type === 'noteReference')
    )
      return source;
    if (
      node.type === 'text' &&
      source?.type === 'text' &&
      node.text === source.text
    ) {
      const styleMarks =
        source.marks?.filter((mark) => mark.type === 'style') ?? [];
      return styleMarks.length > 0
        ? {
            ...node,
            marks: [
              ...(node.marks ?? []),
              ...styleMarks.filter(
                (style) =>
                  style.type === 'style' &&
                  !node.marks?.some(
                    (mark) =>
                      mark.type === 'style' && mark.styleId === style.styleId,
                  ),
              ),
            ],
          }
        : node;
    }
    return node;
  });
}

function restoreTextMarkRanges(
  original: readonly InlineNode[],
  parsed: readonly InlineNode[],
): InlineNode[] | undefined {
  if (
    !original.every((node) => node.type === 'text') ||
    !parsed.every((node) => node.type === 'text')
  )
    return undefined;
  const originalText = original.map((node) => node.text).join('');
  const parsedText = parsed.map((node) => node.text).join('');
  if (originalText !== parsedText) return undefined;
  const boundaries = new Set<number>([0, originalText.length]);
  let offset = 0;
  for (const node of [...original, ...parsed]) {
    offset += node.text.length;
    boundaries.add(offset);
    if (node === original.at(-1)) offset = 0;
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const restored: InlineNode[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? start;
    if (end <= start) continue;
    const originalNode = textNodeAt(original, start);
    const parsedNode = textNodeAt(parsed, start);
    const styleMarks =
      originalNode?.marks?.filter((mark) => mark.type === 'style') ?? [];
    const marks = [
      ...(parsedNode?.marks ?? []),
      ...styleMarks.filter(
        (style) =>
          style.type === 'style' &&
          !parsedNode?.marks?.some(
            (mark) => mark.type === 'style' && mark.styleId === style.styleId,
          ),
      ),
    ];
    restored.push({
      type: 'text',
      text: originalText.slice(start, end),
      ...(marks.length > 0 ? { marks } : {}),
    });
  }
  return restored;
}

function textNodeAt(
  nodes: readonly Extract<InlineNode, { type: 'text' }>[],
  position: number,
): Extract<InlineNode, { type: 'text' }> | undefined {
  let offset = 0;
  for (const node of nodes) {
    if (position < offset + node.text.length) return node;
    offset += node.text.length;
  }
  return nodes.at(-1);
}

function sameBlockIdentity(original: BlockNode, parsed: BlockNode): boolean {
  if (original.type === 'imageBlock' && parsed.type === 'paragraph')
    return singleImage(parsed)?.assetId === original.assetId;
  if (original.type !== parsed.type) return false;
  if (original.type === 'heading' && parsed.type === 'heading') {
    if (original.level !== parsed.level) return false;
    if (original.id) return parsed.id === original.id;
    if (parsed.id) return false;
    const originalText = inlineIdentity(original.children);
    const parsedText = inlineIdentity(parsed.children);
    return (
      parsedText === originalText ||
      (original.numbering !== undefined &&
        parsedText === `${original.numbering} ${originalText}`)
    );
  }
  if (original.type === 'paragraph' && parsed.type === 'paragraph')
    return (
      inlineIdentity(original.children) === inlineIdentity(parsed.children)
    );
  if (original.type === 'imageBlock' && parsed.type === 'imageBlock')
    return original.assetId === parsed.assetId;
  if (original.type === 'equationBlock' && parsed.type === 'equationBlock')
    return original.equationId === parsed.equationId;
  if (original.type === 'codeBlock' && parsed.type === 'codeBlock')
    return original.text === parsed.text;
  if (original.type === 'table' && parsed.type === 'table')
    return (
      original.rows.length === parsed.rows.length &&
      original.rows.every((row, rowIndex) =>
        row.cells.every(
          (cell, cellIndex) =>
            blockSequenceIdentity(cell.blocks) ===
            blockSequenceIdentity(
              parsed.rows[rowIndex]?.cells[cellIndex]?.blocks ?? [],
            ),
        ),
      )
    );
  if (original.type === 'blockquote' && parsed.type === 'blockquote')
    return (
      blockSequenceIdentity(original.blocks) ===
      blockSequenceIdentity(parsed.blocks)
    );
  if (original.type === 'list' && parsed.type === 'list')
    return (
      original.ordered === parsed.ordered &&
      original.items.length === parsed.items.length &&
      original.items.every(
        (item, index) =>
          blockSequenceIdentity(item.blocks) ===
          blockSequenceIdentity(parsed.items[index]?.blocks ?? []),
      )
    );
  return true;
}

function blockSequenceIdentity(blocks: readonly BlockNode[]): string {
  return blocks
    .filter((block) => block.type !== 'pageBreak')
    .map((block) => {
      if (block.type === 'heading' || block.type === 'paragraph')
        return `${block.type}:${inlineIdentity(block.children)}`;
      if (block.type === 'codeBlock') return `code:${block.text}`;
      if (block.type === 'imageBlock') return `image:${block.assetId}`;
      if (block.type === 'equationBlock') return `equation:${block.equationId}`;
      return block.type;
    })
    .join('|');
}

function inlineIdentity(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text;
      if (node.type === 'link')
        return `[${inlineIdentity(node.children)}](${node.href})`;
      if (node.type === 'image') return `[image:${node.assetId}]`;
      if (node.type === 'equation') return `[equation:${node.equationId}]`;
      if (node.type === 'noteReference') return `[note:${node.noteId}]`;
      return node.type === 'lineBreak' ? '\n' : ' ';
    })
    .join('');
}

function withoutHeadingNumber(
  children: readonly InlineNode[],
  numbering: string | undefined,
): InlineNode[] {
  if (!numbering) return [...children];
  const prefix = `${numbering} `;
  const index = children.findIndex((node) => node.type === 'text');
  const node = children[index];
  if (node?.type !== 'text' || !node.text.startsWith(prefix))
    return [...children];
  return [
    ...children.slice(0, index),
    { ...node, text: node.text.slice(prefix.length) },
    ...children.slice(index + 1),
  ];
}

function singleImage(
  block: Extract<BlockNode, { type: 'paragraph' }>,
): Extract<InlineNode, { type: 'image' }> | undefined {
  return block.children.length === 1 && block.children[0]?.type === 'image'
    ? block.children[0]
    : undefined;
}

function withoutItalicWrapper(children: readonly InlineNode[]): InlineNode[] {
  return children.map((node): InlineNode => {
    if (node.type === 'text') {
      const marks = node.marks?.filter((mark) => mark.type !== 'italic');
      if (marks?.length) return { ...node, marks };
      const { marks: _marks, ...text } = node;
      return text;
    }
    if (node.type === 'link')
      return { ...node, children: withoutItalicWrapper(node.children) };
    return node;
  });
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text;
      if (node.type === 'link') return inlineText(node.children);
      if (node.type === 'image') return node.alt ?? '';
      return '';
    })
    .join('')
    .trim();
}

function assetUrls(model: DocumentModel): ReadonlyMap<string, string> {
  return new Map(
    Object.values(model.assets).map((asset) => [
      `data:${asset.mediaType.toLowerCase()};base64,${base64(asset.data)}`,
      asset.id,
    ]),
  );
}

function base64(data: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000)
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
