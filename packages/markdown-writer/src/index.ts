import type {
  BlockNode,
  ConversionWarning,
  DocumentModel,
  InlineNode,
  TextMark,
  WriterOptions,
} from '@wordconvert/document-model';
import { strToU8, zipSync, type Zippable } from 'fflate';

export interface MarkdownWriterOptions extends WriterOptions {
  onWarning?: (warning: ConversionWarning) => void;
}

interface RenderContext {
  model: DocumentModel;
  referencedNotes: string[];
  assetUrl: (assetId: string) => string | undefined;
  warn: (warning: ConversionWarning) => void;
}

export function writeMarkdown(
  model: DocumentModel,
  options: MarkdownWriterOptions,
): string {
  return writeWithAssets(model, options, (assetId) => {
    const asset = model.assets[assetId];
    return asset && isPassiveImage(asset.mediaType)
      ? `data:${asset.mediaType.toLowerCase()};base64,${base64(asset.data)}`
      : undefined;
  });
}

export async function writeMarkdownZip(
  model: DocumentModel,
  options: MarkdownWriterOptions,
): Promise<Uint8Array> {
  const paths = new Map<string, string>();
  const files: Zippable = {};
  let imageNumber = 0;
  for (const id of Object.keys(model.assets).sort()) {
    const asset = model.assets[id];
    if (!asset || !isPassiveImage(asset.mediaType)) continue;
    const extension = imageExtension(asset.mediaType);
    const path = `images/image-${String(++imageNumber).padStart(3, '0')}.${extension}`;
    paths.set(id, path);
    files[path] = asset.data;
  }
  files['document.md'] = strToU8(
    writeWithAssets(model, options, (id) => paths.get(id)),
  );
  const sortedFiles: Zippable = {};
  for (const path of Object.keys(files).sort()) {
    const data = files[path];
    if (data) sortedFiles[path] = data;
  }
  return zipSync(sortedFiles, {
    level: 9,
    mtime: new Date('1980-01-01T00:00:00.000Z'),
  });
}

function writeWithAssets(
  model: DocumentModel,
  options: MarkdownWriterOptions,
  assetUrl: RenderContext['assetUrl'],
): string {
  const context: RenderContext = {
    model,
    referencedNotes: [],
    assetUrl,
    warn: (warning) => options.onWarning?.(warning),
  };
  const body = renderBlocks(model.blocks, context);
  const notes = renderNotes(context);
  return `${body}${notes ? `\n\n${notes}` : ''}\n`;
}

function renderBlocks(blocks: BlockNode[], context: RenderContext): string {
  return blocks
    .map((block) => renderBlock(block, context))
    .filter(Boolean)
    .join('\n\n');
}

function renderBlock(block: BlockNode, context: RenderContext): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${renderInlines(block.children, context)}`;
    case 'paragraph':
      return renderInlines(block.children, context);
    case 'blockquote':
      return renderBlocks(block.blocks, context)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'list':
      return block.items
        .map((item, index) => {
          const marker = block.ordered
            ? `${(block.start ?? 1) + index}. `
            : '- ';
          const content = item.blocks
            .map((itemBlock) => renderBlock(itemBlock, context))
            .reduce(
              (result, value, blockIndex) =>
                `${result}${blockIndex === 0 ? '' : item.blocks[blockIndex]?.type === 'list' ? '\n' : '\n\n'}${value}`,
              '',
            )
            .split('\n');
          return content
            .map((line, lineIndex) =>
              lineIndex === 0
                ? `${marker}${line}`
                : `${' '.repeat(marker.length)}${line}`,
            )
            .join('\n');
        })
        .join('\n');
    case 'table':
      return renderTable(block, context);
    case 'codeBlock': {
      const language = block.language ? sanitizeToken(block.language) : '';
      const text = block.text.replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case 'thematicBreak':
      return '---';
    case 'pageBreak':
      return '<!-- page break -->';
    case 'equationBlock':
      return renderEquation(block.equationId, true, context);
    case 'imageBlock': {
      const image = renderImage(block.assetId, block.alt, undefined, context);
      if (!image) return '';
      return block.caption
        ? `${image}\n\n*${renderInlines(block.caption, context)}*`
        : image;
    }
  }
}

function renderTable(
  block: Extract<BlockNode, { type: 'table' }>,
  context: RenderContext,
): string {
  for (const row of block.rows) {
    for (const cell of row.cells) {
      if ((cell.colSpan ?? 1) !== 1 || (cell.rowSpan ?? 1) !== 1) {
        context.warn({
          code: 'markdown-table-span',
          severity: 'warning',
          message: 'Markdown tables cannot preserve merged cell spans.',
          details: { colSpan: cell.colSpan ?? 1, rowSpan: cell.rowSpan ?? 1 },
        });
      }
    }
  }
  if (block.rows.length === 0)
    return block.caption ? `*${renderInlines(block.caption, context)}*` : '';
  const width = Math.max(...block.rows.map((row) => row.cells.length), 1);
  const rows = block.rows.map((row) =>
    Array.from({ length: width }, (_, index) =>
      renderTableCell(row.cells[index]?.blocks ?? [], context),
    ),
  );
  const first = rows[0] ?? Array.from({ length: width }, () => '');
  const body = rows.slice(1);
  const table = [first, Array.from({ length: width }, () => '---'), ...body]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
  return block.caption
    ? `*${renderInlines(block.caption, context)}*\n\n${table}`
    : table;
}

function renderTableCell(blocks: BlockNode[], context: RenderContext): string {
  return renderBlocks(blocks, context)
    .replace(/\|/g, '\\|')
    .replace(/ {2}\n|\n+/g, '<br>');
}

function renderInlines(nodes: InlineNode[], context: RenderContext): string {
  return nodes.map((node) => renderInline(node, context)).join('');
}

function renderInline(node: InlineNode, context: RenderContext): string {
  if (node.type === 'text')
    return renderText(node.text, node.marks ?? [], context);
  if (node.type === 'link') {
    const title = node.title
      ? ` "${node.title.replace(/["\\]/g, '\\$&')}"`
      : '';
    const children = renderInlines(node.children, context);
    if (!safeHref(node.href)) {
      context.warn({
        code: 'markdown-unsafe-link',
        severity: 'warning',
        message: 'An unsafe hyperlink target was omitted.',
        details: { hrefScheme: hrefScheme(node.href) },
      });
      return children;
    }
    return `[${children}](${escapeDestination(node.href.trim())}${title})`;
  }
  if (node.type === 'image')
    return renderImage(node.assetId, node.alt, node.title, context);
  if (node.type === 'equation')
    return renderEquation(node.equationId, false, context);
  if (node.type === 'noteReference') {
    if (!context.referencedNotes.includes(node.noteId))
      context.referencedNotes.push(node.noteId);
    return `[^${safeLabel(node.noteId)}]`;
  }
  if (node.type === 'lineBreak') return '  \n';
  if (node.type === 'softBreak') return '\n';
  return '';
}

function renderImage(
  assetId: string,
  alt: string | undefined,
  title: string | undefined,
  context: RenderContext,
): string {
  const url = context.assetUrl(assetId);
  if (!url) {
    const asset = context.model.assets[assetId];
    context.warn(
      asset
        ? {
            code: 'markdown-unsupported-image',
            severity: 'warning',
            message: 'An image with an unsupported media type was omitted.',
            details: { assetId, mediaType: asset.mediaType },
          }
        : {
            code: 'markdown-missing-asset',
            severity: 'warning',
            message: 'An image referencing a missing asset was omitted.',
            details: { assetId },
          },
    );
    return '';
  }
  const titlePart = title ? ` "${title.replace(/["\\]/g, '\\$&')}"` : '';
  return `![${escapeText(alt ?? '')}](${url}${titlePart})`;
}

function renderEquation(
  equationId: string,
  block: boolean,
  context: RenderContext,
): string {
  const equation = context.model.equations[equationId];
  if (!equation) {
    context.warn({
      code: 'markdown-missing-equation',
      severity: 'warning',
      message:
        'A reference to a missing equation was replaced with fallback text.',
      details: { equationId },
    });
    return '[Equation unavailable]';
  }
  const value = equation.tex ?? equation.mathml ?? equation.source.value;
  return block ? `$$\n${value}\n$$` : `$${value}$`;
}

function renderNotes(context: RenderContext): string {
  return context.referencedNotes
    .flatMap((id) => {
      const note = context.model.notes[id];
      if (!note) {
        context.warn({
          code: 'markdown-missing-note',
          severity: 'warning',
          message: 'A reference to a missing note has no note definition.',
          details: { noteId: id },
        });
        return [];
      }
      const body = renderBlocks(note.blocks, context).replace(/\n/g, '\n    ');
      return [`[^${safeLabel(id)}]: ${body}`];
    })
    .join('\n\n');
}

function applyMarks(
  value: string,
  marks: TextMark[],
  context: RenderContext,
): string {
  return marks.reduce((content, mark) => {
    if (mark.type === 'bold') return `**${content}**`;
    if (mark.type === 'italic') return `_${content}_`;
    if (mark.type === 'strikethrough') return `~~${content}~~`;
    if (mark.type === 'underline') return `<u>${content}</u>`;
    if (mark.type === 'subscript') return `<sub>${content}</sub>`;
    if (mark.type === 'superscript') return `<sup>${content}</sup>`;
    if (mark.type === 'code') return content;
    if (mark.type === 'style') {
      context.warn({
        code: 'markdown-unsupported-style-mark',
        severity: 'info',
        message: 'A custom character style has no Markdown representation.',
        details: { styleId: mark.styleId },
      });
    }
    return content;
  }, value);
}

function renderText(
  value: string,
  marks: TextMark[],
  context: RenderContext,
): string {
  const content = marks.some((mark) => mark.type === 'code')
    ? inlineCode(value)
    : escapeText(value);
  return applyMarks(content, marks, context);
}

function inlineCode(value: string): string {
  const fence = '`'.repeat(longestRun(value, '`') + 1);
  const padding = value.includes('`') || /^ | $/.test(value) ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function longestRun(value: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const item of value) {
    current = item === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function escapeText(value: string): string {
  return value.replace(/[\\`*_[\]<>#]/g, '\\$&');
}

function escapeDestination(value: string): string {
  return value.replace(/[()\\]/g, '\\$&');
}

function safeHref(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:https?:|mailto:)/i.test(trimmed) ||
    /^#[A-Za-z0-9_.:-]+$/.test(trimmed) ||
    /^(?:\.\.?\/|\/)?[^\s\\:]+(?:\/[^\s\\]*)?$/.test(trimmed)
  );
}

function hrefScheme(value: string): string {
  return (
    /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase() ??
    'unknown'
  );
}

function sanitizeToken(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

function safeLabel(value: string): string {
  return sanitizeToken(value.replace(/_/g, '-'));
}

function isPassiveImage(mediaType: string): boolean {
  return /^(?:image\/(?:avif|gif|jpeg|png|webp))$/i.test(mediaType);
}

function imageExtension(mediaType: string): string {
  const subtype = mediaType.toLowerCase().slice('image/'.length);
  return subtype === 'jpeg' ? 'jpg' : subtype;
}

function base64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const value =
      ((bytes[index] ?? 0) << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    output += alphabet[(value >> 18) & 63] ?? '';
    output += alphabet[(value >> 12) & 63] ?? '';
    output +=
      index + 1 < bytes.length ? (alphabet[(value >> 6) & 63] ?? '') : '=';
    output += index + 2 < bytes.length ? (alphabet[value & 63] ?? '') : '=';
  }
  return output;
}
