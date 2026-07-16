import type {
  BlockNode,
  DocumentAsset,
  DocumentModel,
  InlineNode,
  TextMark,
  WriterOptions,
} from '@wordconvert/document-model';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  KATEX_STYLES,
  renderEquation as renderMathEquation,
  type MathOutputMode,
} from '@wordconvert/math-converter';

export interface HtmlWriterOptions extends WriterOptions {
  mode?: 'standalone' | 'fragment';
  formulaMode?: MathOutputMode;
}

interface HeadingEntry {
  level: number;
  id: string;
  label: string;
}

interface RenderContext {
  model: DocumentModel;
  headings: HeadingEntry[];
  headingIndex: number;
  referencedNotes: string[];
  assetUrl: (asset: DocumentAsset) => string | undefined;
  formulaMode: MathOutputMode;
}

const STYLES = `:root{color-scheme:light dark;--background:#fff;--foreground:#202124;--muted:#5f6368;--link:#0759b6}*{box-sizing:border-box}body{max-width:48rem;margin:0 auto;padding:2rem;font:18px/1.6 system-ui,sans-serif;background:var(--background);color:var(--foreground)}h1,h2,h3,h4,h5,h6{clear:both;line-height:1.2;margin-block:1.6em .6em}p,ul,ol,blockquote,figure,table,pre{margin-block:0 1.25em}img{max-width:100%;height:auto}p>img{display:block;clear:both;margin-block:1.25em}figure{clear:both;margin-inline:0}figure>img{display:block}figcaption{margin-top:.5em;color:var(--muted)}table{clear:both;border-collapse:collapse;width:100%}th,td{border:1px solid var(--muted);padding:.4rem;text-align:left;vertical-align:top}a{color:var(--link)}pre{clear:both;overflow:auto}.page-break{clear:both;break-after:page}.table-of-contents{clear:both}.table-of-contents ol{padding-left:1.5rem}@media (prefers-color-scheme: dark){:root{--background:#181a1b;--foreground:#eee;--muted:#aaa;--link:#8ab4f8}}@media print{body{max-width:none;padding:0;font-size:12pt}.table-of-contents{break-after:page}a{color:inherit;text-decoration:none}}`;
const SAFE_EMBEDDED_MEDIA = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function writeHtml(
  model: DocumentModel,
  options: HtmlWriterOptions,
): string {
  const fragment = writeFragment(
    model,
    (asset) => dataUrl(asset),
    options.formulaMode ?? 'source',
  );
  if (options.mode === 'fragment') return fragment;
  const title = escapeHtml(model.metadata.title?.value ?? 'Untitled document');
  const language = sanitizeLanguage(model.metadata.language?.value ?? 'en');
  const metadata = renderMetadata(model);
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="WordConvert">${metadata}<title>${title}</title><style>${embeddedFontCss(model)}${options.formulaMode === 'katex' ? KATEX_STYLES : ''}${STYLES}</style></head><body>${fragment}</body></html>`;
}

export async function writeHtmlZip(
  model: DocumentModel,
  options: HtmlWriterOptions,
): Promise<Uint8Array> {
  const registry = createZipAssetRegistry(model);
  const fragment = writeFragment(
    model,
    (asset) => registry.paths.get(asset.id),
    options.formulaMode ?? 'source',
  );
  const title = escapeHtml(model.metadata.title?.value ?? 'Untitled document');
  const language = sanitizeLanguage(model.metadata.language?.value ?? 'en');
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="WordConvert">${renderMetadata(model)}<title>${title}</title><link rel="stylesheet" href="styles.css"></head><body>${fragment}</body></html>`;
  const fontCss = registry.fonts
    .map(
      ({ path }, index) =>
        `@font-face{font-family:"WordConvert ${index + 1}";src:url("${path}")}`,
    )
    .join('');
  const files: Zippable = {
    'document.html': strToU8(html),
    'styles.css': strToU8(
      `${fontCss}${options.formulaMode === 'katex' ? KATEX_STYLES : ''}${STYLES}`,
    ),
  };
  for (const { asset, path } of registry.entries) files[path] = asset.data;
  const deterministicFiles: Zippable = {};
  for (const path of Object.keys(files).sort()) {
    const data = files[path];
    if (data) deterministicFiles[path] = data;
  }
  return zipSync(deterministicFiles, {
    level: 9,
    mtime: new Date('1980-01-01T00:00:00.000Z'),
  });
}

interface ZipAssetEntry {
  asset: DocumentAsset;
  path: string;
}

function createZipAssetRegistry(model: DocumentModel): {
  entries: ZipAssetEntry[];
  fonts: ZipAssetEntry[];
  paths: Map<string, string>;
} {
  const entries: ZipAssetEntry[] = [];
  const fonts: ZipAssetEntry[] = [];
  const paths = new Map<string, string>();
  let imageNumber = 0;
  let fontNumber = 0;
  for (const id of Object.keys(model.assets).sort()) {
    const asset = model.assets[id];
    if (!asset) continue;
    const mediaType = asset.mediaType.toLowerCase();
    const extension = MEDIA_EXTENSIONS[mediaType];
    if (!extension) continue;
    const isFont = mediaType.startsWith('font/');
    const number = isFont ? ++fontNumber : ++imageNumber;
    const path = isFont
      ? `fonts/font-${String(number).padStart(3, '0')}.${extension}`
      : `images/image-${String(number).padStart(3, '0')}.${extension}`;
    const entry = { asset, path };
    entries.push(entry);
    if (isFont) fonts.push(entry);
    paths.set(id, path);
  }
  return { entries, fonts, paths };
}

function writeFragment(
  model: DocumentModel,
  assetUrl: RenderContext['assetUrl'],
  formulaMode: MathOutputMode,
): string {
  const headings = collectHeadings(model.blocks);
  const context: RenderContext = {
    model,
    headings,
    headingIndex: 0,
    referencedNotes: [],
    assetUrl,
    formulaMode,
  };
  const content = renderBlocks(model.blocks, context);
  const notes = renderNotes(context);
  return `<main>${renderDocumentTitle(model)}${renderToc(headings)}${content}${notes}</main>`;
}

function renderDocumentTitle(model: DocumentModel): string {
  const title = model.metadata.title?.value.trim();
  if (!title || hasMatchingTitleHeading(model.blocks, title)) return '';
  return `<h1 class="document-title">${escapeHtml(title)}</h1>`;
}

function hasMatchingTitleHeading(blocks: BlockNode[], title: string): boolean {
  const expected = normaliseText(title);
  return blocks.some(
    (block) =>
      block.type === 'heading' &&
      block.level === 1 &&
      normaliseText(plainText(block.children)) === expected,
  );
}

function normaliseText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function collectHeadings(blocks: BlockNode[]): HeadingEntry[] {
  const counts = new Map<string, number>();
  const headings: HeadingEntry[] = [];
  const visit = (nodes: BlockNode[]): void => {
    for (const block of nodes) {
      if (block.type === 'heading') {
        const label = plainText(block.children);
        const base = slug(block.id ?? label);
        const count = (counts.get(base) ?? 0) + 1;
        counts.set(base, count);
        headings.push({
          level: block.level,
          id: count === 1 ? base : `${base}-${count}`,
          label,
        });
      } else if (block.type === 'list') {
        for (const item of block.items) visit(item.blocks);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) visit(cell.blocks);
      } else if (block.type === 'blockquote') visit(block.blocks);
    }
  };
  visit(blocks);
  return headings;
}

function renderToc(headings: HeadingEntry[]): string {
  if (headings.length === 0) return '';
  return `<div class="table-of-contents"><h2>Contents</h2><ol>${headings.map(({ id, label }) => `<li><a href="#${escapeAttribute(id)}">${escapeHtml(label)}</a></li>`).join('')}</ol></div>`;
}

function renderBlocks(blocks: BlockNode[], context: RenderContext): string {
  return blocks.map((block) => renderBlock(block, context)).join('');
}

function renderBlock(block: BlockNode, context: RenderContext): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${renderInlines(block.children, context)}</p>`;
    case 'heading': {
      const heading = context.headings[context.headingIndex++];
      return `<h${block.level} id="${escapeAttribute(heading?.id ?? 'section')}">${renderInlines(block.children, context)}</h${block.level}>`;
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const start =
        block.ordered && block.start !== undefined
          ? ` start="${block.start}"`
          : '';
      return `<${tag}${start}>${block.items.map((item) => `<li>${renderBlocks(item.blocks, context)}</li>`).join('')}</${tag}>`;
    }
    case 'table':
      return `<table>${block.caption ? `<caption>${renderInlines(block.caption, context)}</caption>` : ''}<tbody>${block.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => {
                const tag = cell.header ? 'th' : 'td';
                const colSpan =
                  cell.colSpan === undefined
                    ? ''
                    : ` colspan="${cell.colSpan}"`;
                const rowSpan =
                  cell.rowSpan === undefined
                    ? ''
                    : ` rowspan="${cell.rowSpan}"`;
                return `<${tag}${colSpan}${rowSpan}>${renderBlocks(cell.blocks, context)}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody></table>`;
    case 'blockquote':
      return `<blockquote>${renderBlocks(block.blocks, context)}</blockquote>`;
    case 'codeBlock': {
      const language = block.language
        ? ` class="language-${sanitizeToken(block.language)}"`
        : '';
      return `<pre><code${language}>${escapeHtml(block.text)}</code></pre>`;
    }
    case 'equationBlock':
      return `<div class="equation" role="math">${renderEquation(block.equationId, true, context)}</div>`;
    case 'imageBlock': {
      const image = renderImage(block.assetId, block.alt, undefined, context);
      if (!image) return '';
      return `<figure>${image}${block.caption ? `<figcaption>${renderInlines(block.caption, context)}</figcaption>` : ''}</figure>`;
    }
    case 'thematicBreak':
      return '<hr>';
    case 'pageBreak':
      return '<div class="page-break" aria-hidden="true"></div>';
  }
}

function renderInlines(nodes: InlineNode[], context: RenderContext): string {
  return nodes.map((node) => renderInline(node, context)).join('');
}

function renderInline(node: InlineNode, context: RenderContext): string {
  switch (node.type) {
    case 'text':
      return applyMarks(escapeHtml(node.text), node.marks ?? []);
    case 'link': {
      const children = renderInlines(node.children, context);
      const href = safeHref(node.href);
      const title = node.title ? ` title="${escapeAttribute(node.title)}"` : '';
      return href
        ? `<a href="${escapeAttribute(href)}"${title}>${children}</a>`
        : children;
    }
    case 'image':
      return renderImage(node.assetId, node.alt, node.title, context);
    case 'equation':
      return `<span class="equation" role="math">${renderEquation(node.equationId, false, context)}</span>`;
    case 'noteReference': {
      if (!context.referencedNotes.includes(node.noteId))
        context.referencedNotes.push(node.noteId);
      const id = safeId(node.noteId);
      return `<sup id="note-ref-${id}"><a href="#note-${id}" role="doc-noteref">[${context.referencedNotes.indexOf(node.noteId) + 1}]</a></sup>`;
    }
    case 'lineBreak':
      return '<br>';
    case 'softBreak':
      return '\n';
  }
}

function applyMarks(value: string, marks: TextMark[]): string {
  return marks.reduce((content, mark) => {
    if (mark.type === 'bold') return `<strong>${content}</strong>`;
    if (mark.type === 'italic') return `<em>${content}</em>`;
    if (mark.type === 'underline') return `<u>${content}</u>`;
    if (mark.type === 'strikethrough') return `<s>${content}</s>`;
    if (mark.type === 'subscript') return `<sub>${content}</sub>`;
    if (mark.type === 'superscript') return `<sup>${content}</sup>`;
    if (mark.type === 'code') return `<code>${content}</code>`;
    if (mark.type === 'style')
      return `<span class="style-${sanitizeToken(mark.styleId)}">${content}</span>`;
    return content;
  }, value);
}

function renderImage(
  assetId: string,
  alt: string | undefined,
  title: string | undefined,
  context: RenderContext,
): string {
  const asset = context.model.assets[assetId];
  if (!asset) return '';
  const source = context.assetUrl(asset);
  if (!source) return '';
  const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
  return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt ?? '')}"${titleAttribute}>`;
}

function renderEquation(
  id: string,
  display: boolean,
  context: RenderContext,
): string {
  return renderMathEquation(context.model.equations[id], {
    mode: context.formulaMode,
    display,
  });
}

function renderNotes(context: RenderContext): string {
  const notes = context.referencedNotes.flatMap((id, index) => {
    const note = context.model.notes[id];
    if (!note) return [];
    const safe = safeId(id);
    return [
      `<li id="note-${safe}">${renderBlocks(note.blocks, context)}<a href="#note-ref-${safe}" role="doc-backlink" aria-label="Back to reference ${index + 1}">↩</a></li>`,
    ];
  });
  return notes.length === 0
    ? ''
    : `<section class="notes" aria-label="Notes"><h2>Notes</h2><ol>${notes.join('')}</ol></section>`;
}

function renderMetadata(model: DocumentModel): string {
  const authors = model.metadata.authors
    .map(
      (author) =>
        `<meta name="author" content="${escapeAttribute(author.value.name)}">`,
    )
    .join('');
  const description = model.metadata.description?.value;
  const descriptionMeta = description
    ? `<meta name="description" content="${escapeAttribute(description)}">`
    : '';
  return `${authors}${descriptionMeta}`;
}

function dataUrl(asset: DocumentAsset): string | undefined {
  if (!SAFE_EMBEDDED_MEDIA.has(asset.mediaType.toLowerCase())) return undefined;
  return `data:${asset.mediaType.toLowerCase()};base64,${base64(asset.data)}`;
}

function embeddedFontCss(model: DocumentModel): string {
  return Object.keys(model.assets)
    .sort()
    .flatMap((id, index) => {
      const asset = model.assets[id];
      if (!asset || !asset.mediaType.toLowerCase().startsWith('font/'))
        return [];
      const mediaType = asset.mediaType.toLowerCase();
      if (!MEDIA_EXTENSIONS[mediaType]) return [];
      return [
        `@font-face{font-family:"WordConvert ${index + 1}";src:url("data:${mediaType};base64,${base64(asset.data)}")}`,
      ];
    })
    .join('');
}

function base64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >> 18) & 63] ?? '';
    output += alphabet[(value >> 12) & 63] ?? '';
    output +=
      index + 1 < bytes.length ? (alphabet[(value >> 6) & 63] ?? '') : '=';
    output += index + 2 < bytes.length ? (alphabet[value & 63] ?? '') : '=';
  }
  return output;
}

function safeHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    /^(?:https?:|mailto:)/i.test(trimmed) ||
    /^#[A-Za-z0-9_.:-]+$/.test(trimmed)
  )
    return trimmed;
  return undefined;
}

function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.type === 'link'
          ? plainText(node.children)
          : '',
    )
    .join('');
}

function slug(value: string): string {
  const result = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return result || 'section';
}

function safeId(value: string): string {
  return slug(value);
}

function sanitizeToken(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

function sanitizeLanguage(value: string): string {
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) ? value : 'en';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;',
  );
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
