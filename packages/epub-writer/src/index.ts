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
  createCoverSvg,
  type CoverComposition,
} from '@wordconvert/cover-generator';
import {
  KATEX_STYLES,
  renderEquation as renderMathEquation,
  type MathOutputMode,
} from '@wordconvert/math-converter';

export interface EpubWriterOptions extends WriterOptions {
  identifier?: string;
  title?: string;
  language?: string;
  /** EPUB 3 package modification time, in UTC second precision. */
  modified?: string;
  cover?: CoverComposition;
  formulaMode?: MathOutputMode;
}

interface Chapter {
  id: string;
  path: string;
  blocks: BlockNode[];
}

interface HeadingEntry {
  id: string;
  label: string;
  path: string;
}

interface AssetEntry {
  asset: DocumentAsset;
  id: string;
  path: string;
  mediaType: string;
}

interface RenderContext {
  model: DocumentModel;
  assetPaths: ReadonlyMap<string, string>;
  headings: HeadingEntry[];
  headingIndex: number;
  referencedNotes: string[];
  formulaMode: MathOutputMode;
}

const ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const STYLES = [
  /* Base */
  'body{font-family:Georgia,"Times New Roman",Times,serif;font-size:1em;line-height:1.6;color:#1a1a1a;margin:0 auto;max-width:36em;padding:1.5em 1em;-epub-hyphens:auto;hyphens:auto}',
  /* Headings */
  'h1,h2,h3,h4,h5,h6{font-family:inherit;font-weight:bold;line-height:1.25;margin-top:1.5em;margin-bottom:.5em;color:#111;-epub-hyphens:none;hyphens:none}',
  'h1{font-size:1.875em;page-break-before:always}',
  'h1:first-child{page-break-before:avoid}',
  'h2{font-size:1.5em}h3{font-size:1.25em}h4{font-size:1.125em}h5,h6{font-size:1em}',
  /* Paragraphs */
  'p{margin:0 0 .75em}',
  /* Links */
  'a{color:#0645ad;text-decoration:underline}',
  /* Images */
  'img{max-width:100%;height:auto;display:block;margin:1em auto}',
  'figure{margin:1.5em 0;text-align:center}',
  'figcaption{font-size:.875em;color:#555;margin-top:.4em;font-style:italic}',
  /* Tables */
  'table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9em}',
  'th,td{border:1px solid #bbb;padding:.4em .6em;text-align:left;vertical-align:top}',
  'th{background:#f0f0f0;font-weight:bold}',
  'caption{caption-side:top;font-weight:bold;margin-bottom:.5em;text-align:center}',
  /* Code */
  'code,kbd,samp{font-family:"Courier New",Courier,monospace;font-size:.875em;background:#f5f5f5;padding:.1em .3em}',
  'pre{background:#f5f5f5;border:1px solid #ddd;padding:.75em 1em;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:.875em;margin:1em 0}',
  'pre code{background:none;padding:0;font-size:1em}',
  /* Blockquotes */
  'blockquote{margin:1em 0 1em 1em;padding:.5em 0 .5em 1em;border-left:4px solid #ccc;color:#555}',
  /* Lists */
  'ul,ol{margin:.75em 0;padding-left:2em}li{margin:.25em 0}',
  /* HR */
  'hr{border:none;border-top:1px solid #ccc;margin:2em 0}',
  /* Equations — MathML display */
  '.equation{margin:1em 0;text-align:center;overflow-x:auto}',
  'math{display:inline}math[display="block"]{display:block;margin:1em auto;overflow-x:auto}',
  /* Footnotes */
  '.footnotes{font-size:.875em;border-top:1px solid #ccc;margin-top:2em;padding-top:1em}',
  'a.footnote-ref{font-size:.75em;vertical-align:super;text-decoration:none}',
  'a.footnote-backref{text-decoration:none}',
  /* Page breaks */
  '.page-break{break-after:page;page-break-after:always;height:0;display:block}',
  /* Title page */
  '.subtitle{font-size:1.25em;font-style:italic;color:#444;margin-top:.5em}',
  '.author{font-size:1.125em;margin-top:.75em;color:#333}',
].join('');
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

export async function writeEpub(
  model: DocumentModel,
  options: EpubWriterOptions,
): Promise<Uint8Array> {
  const metadata = resolveMetadata(model, options);
  const chapters = splitChapters(model.blocks);
  const assets = createAssetRegistry(model);
  const assetPaths = new Map(
    assets.map(({ asset, path }) => [asset.id, path.replace('EPUB/', '')]),
  );
  const headings = collectHeadings(chapters);
  const files: Zippable = {};
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(containerXml());
  files['EPUB/package.opf'] = strToU8(
    packageXml(metadata, model, chapters, assets, options.cover !== undefined),
  );
  files['EPUB/nav.xhtml'] = strToU8(navXhtml(metadata, headings));
  files['EPUB/styles.css'] = strToU8(
    `${options.formulaMode === 'katex' ? KATEX_STYLES : ''}${STYLES}`,
  );
  if (options.cover) {
    files['EPUB/cover.svg'] = strToU8(createCoverSvg(options.cover));
    files['EPUB/cover.xhtml'] = strToU8(coverXhtml(metadata));
  }
  files['EPUB/title.xhtml'] = strToU8(titleXhtml(metadata, model));
  for (const chapter of chapters) {
    files[`EPUB/${chapter.path}`] = strToU8(
      chapterXhtml(
        chapter,
        metadata,
        model,
        assetPaths,
        headings,
        options.formulaMode ?? 'mathml',
      ),
    );
  }
  for (const entry of assets) files[entry.path] = entry.asset.data;
  return zipSync(files, { level: 9, mtime: ZIP_TIME });
}

interface PublicationMetadata {
  identifier: string;
  title: string;
  language: string;
  modified: string;
}

function resolveMetadata(
  model: DocumentModel,
  options: EpubWriterOptions,
): PublicationMetadata {
  const identifier = options.identifier ?? model.metadata.identifier?.value;
  const title = options.title ?? model.metadata.title?.value;
  const language = options.language ?? model.metadata.language?.value;
  const modified =
    options.modified ?? normalizeModified(options.conversionDate);
  if (!identifier?.trim()) throw new TypeError('EPUB identifier is required.');
  if (!title?.trim()) throw new TypeError('EPUB title is required.');
  if (!language || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language))
    throw new TypeError('EPUB language must be a valid BCP 47 language tag.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(modified))
    throw new TypeError(
      'EPUB modified timestamp must be UTC ISO 8601 with second precision.',
    );
  return {
    identifier: identifier.trim(),
    title: title.trim(),
    language,
    modified,
  };
}

function normalizeModified(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(
    value,
  );
  return match?.[1] ? `${match[1]}Z` : value;
}

function splitChapters(blocks: BlockNode[]): Chapter[] {
  const groups: BlockNode[][] = [];
  let current: BlockNode[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2 && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);
  return groups.map((chapterBlocks, index) => {
    const number = String(index + 1).padStart(3, '0');
    return {
      id: `chapter-${number}`,
      path: `chapter-${number}.xhtml`,
      blocks: chapterBlocks,
    };
  });
}

function createAssetRegistry(model: DocumentModel): AssetEntry[] {
  let imageNumber = 0;
  let fontNumber = 0;
  return Object.keys(model.assets)
    .sort()
    .flatMap((key) => {
      const asset = model.assets[key];
      if (!asset) return [];
      const mediaType = asset.mediaType.toLowerCase();
      const extension = MEDIA_EXTENSIONS[mediaType];
      if (!extension) return [];
      const isFont = mediaType.startsWith('font/');
      const number = isFont ? ++fontNumber : ++imageNumber;
      const base = isFont ? 'font' : 'image';
      const directory = isFont ? 'fonts' : 'images';
      const serial = String(number).padStart(3, '0');
      return [
        {
          asset,
          id: `${base}-${serial}`,
          path: `EPUB/${directory}/${base}-${serial}.${extension}`,
          mediaType,
        },
      ];
    });
}

function collectHeadings(chapters: Chapter[]): HeadingEntry[] {
  const counts = new Map<string, number>();
  const output: HeadingEntry[] = [];
  const visit = (blocks: BlockNode[], path: string): void => {
    for (const block of blocks) {
      if (block.type === 'heading') {
        const label = plainText(block.children);
        const base = slug(block.id ?? label);
        const count = (counts.get(base) ?? 0) + 1;
        counts.set(base, count);
        output.push({
          id: count === 1 ? base : `${base}-${count}`,
          label: label || 'Untitled section',
          path,
        });
      } else if (block.type === 'list') {
        for (const item of block.items) visit(item.blocks, path);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) visit(cell.blocks, path);
      } else if (block.type === 'blockquote') visit(block.blocks, path);
    }
  };
  for (const chapter of chapters) visit(chapter.blocks, chapter.path);
  return output;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}

function packageXml(
  metadata: PublicationMetadata,
  model: DocumentModel,
  chapters: Chapter[],
  assets: AssetEntry[],
  hasCover: boolean,
): string {
  const creators = model.metadata.authors
    .map(({ value }) => `<dc:creator>${escapeXml(value.name)}</dc:creator>`)
    .join('');
  const chapterItems = chapters
    .map(
      ({ id, path }) =>
        `<item id="${id}" href="${path}" media-type="application/xhtml+xml"/>`,
    )
    .join('');
  const assetItems = assets
    .map(
      ({ id, path, mediaType }) =>
        `<item id="${id}" href="${escapeAttribute(path.replace('EPUB/', ''))}" media-type="${mediaType}"/>`,
    )
    .join('');
  const spine = chapters.map(({ id }) => `<itemref idref="${id}"/>`).join('');
  const coverItems = hasCover
    ? '<item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>'
    : '';
  const coverSpine = hasCover ? '<itemref idref="cover-page"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeAttribute(metadata.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${escapeXml(metadata.identifier)}</dc:identifier><dc:title>${escapeXml(metadata.title)}</dc:title><dc:language>${escapeXml(metadata.language)}</dc:language>${creators}<meta property="dcterms:modified">${metadata.modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="styles" href="styles.css" media-type="text/css"/>${coverItems}<item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>${chapterItems}${assetItems}</manifest><spine>${coverSpine}<itemref idref="title-page"/>${spine}</spine></package>`;
}

function coverXhtml(metadata: PublicationMetadata): string {
  return xhtmlDocument(
    metadata,
    `Cover for ${metadata.title}`,
    `<section epub:type="cover"><img src="cover.svg" alt="Cover for ${escapeAttribute(metadata.title)}"/></section>`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function navXhtml(
  metadata: PublicationMetadata,
  headings: HeadingEntry[],
): string {
  const items = headings.length
    ? headings
        .map(
          ({ path, id, label }) =>
            `<li><a href="${path}#${escapeAttribute(id)}">${escapeXml(label)}</a></li>`,
        )
        .join('')
    : '<li><a href="chapter-001.xhtml">Document</a></li>';
  return xhtmlDocument(
    metadata,
    'Contents',
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${items}</ol></nav>`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function titleXhtml(
  metadata: PublicationMetadata,
  model: DocumentModel,
): string {
  const subtitle = model.metadata.subtitle?.value;
  const authors = model.metadata.authors
    .map(({ value }) => `<p class="author">${escapeXml(value.name)}</p>`)
    .join('');
  return xhtmlDocument(
    metadata,
    metadata.title,
    `<section epub:type="titlepage"><h1>${escapeXml(metadata.title)}</h1>${subtitle ? `<p class="subtitle">${escapeXml(subtitle)}</p>` : ''}${authors}</section>`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function chapterXhtml(
  chapter: Chapter,
  metadata: PublicationMetadata,
  model: DocumentModel,
  assetPaths: ReadonlyMap<string, string>,
  headings: HeadingEntry[],
  formulaMode: MathOutputMode,
): string {
  const firstHeading = headings.find(({ path }) => path === chapter.path);
  const context: RenderContext = {
    model,
    assetPaths,
    headings,
    headingIndex: headings.findIndex(({ path }) => path === chapter.path),
    referencedNotes: [],
    formulaMode,
  };
  if (context.headingIndex < 0) context.headingIndex = headings.length;
  const body = renderBlocks(chapter.blocks, context);
  return xhtmlDocument(
    metadata,
    firstHeading?.label ?? metadata.title,
    `${body}${renderNotes(context)}`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function xhtmlDocument(
  metadata: PublicationMetadata,
  title: string,
  body: string,
  namespace = '',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"${namespace} xml:lang="${escapeAttribute(metadata.language)}" lang="${escapeAttribute(metadata.language)}"><head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body>${body}</body></html>`;
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
    case 'codeBlock':
      return `<pre><code>${escapeXml(block.text)}</code></pre>`;
    case 'equationBlock':
      return `<div class="equation" role="math">${renderEquation(block.equationId, true, context)}</div>`;
    case 'imageBlock': {
      const image = renderImage(block.assetId, block.alt, undefined, context);
      if (!image) return '';
      return `<figure>${image}${block.caption ? `<figcaption>${renderInlines(block.caption, context)}</figcaption>` : ''}</figure>`;
    }
    case 'thematicBreak':
      return '<hr/>';
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
      return applyMarks(escapeXml(node.text), node.marks ?? []);
    case 'link': {
      const content = renderInlines(node.children, context);
      const href = safeHref(node.href);
      return href
        ? `<a href="${escapeAttribute(href)}"${node.title ? ` title="${escapeAttribute(node.title)}"` : ''}>${content}</a>`
        : content;
    }
    case 'image':
      return renderImage(node.assetId, node.alt, node.title, context);
    case 'equation':
      return `<span class="equation" role="math">${renderEquation(node.equationId, false, context)}</span>`;
    case 'noteReference': {
      if (!context.referencedNotes.includes(node.noteId))
        context.referencedNotes.push(node.noteId);
      const id = slug(node.noteId);
      return `<a id="note-ref-${id}" href="#note-${id}" epub:type="noteref">[${context.referencedNotes.indexOf(node.noteId) + 1}]</a>`;
    }
    case 'lineBreak':
      return '<br/>';
    case 'softBreak':
      return '\n';
  }
}

function applyMarks(value: string, marks: TextMark[]): string {
  return marks.reduce((content, mark) => {
    if (mark.type === 'bold') return `<strong>${content}</strong>`;
    if (mark.type === 'italic') return `<em>${content}</em>`;
    if (mark.type === 'underline')
      return `<span class="underline">${content}</span>`;
    if (mark.type === 'strikethrough') return `<s>${content}</s>`;
    if (mark.type === 'subscript') return `<sub>${content}</sub>`;
    if (mark.type === 'superscript') return `<sup>${content}</sup>`;
    if (mark.type === 'code') return `<code>${content}</code>`;
    if (mark.type === 'style')
      return `<span class="style-${slug(mark.styleId)}">${content}</span>`;
    return content;
  }, value);
}

function renderImage(
  assetId: string,
  alt: string | undefined,
  title: string | undefined,
  context: RenderContext,
): string {
  const path = context.assetPaths.get(assetId);
  if (!path) return '';
  return `<img src="${escapeAttribute(path)}" alt="${escapeAttribute(alt ?? '')}"${title ? ` title="${escapeAttribute(title)}"` : ''}/>`;
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
  const notes = context.referencedNotes.flatMap((id) => {
    const note = context.model.notes[id];
    if (!note) return [];
    const safe = slug(id);
    return [
      `<li id="note-${safe}" epub:type="footnote">${renderBlocks(note.blocks, context)}<a href="#note-ref-${safe}">↩</a></li>`,
    ];
  });
  return notes.length
    ? `<section epub:type="footnotes"><ol>${notes.join('')}</ol></section>`
    : '';
}

function safeHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#[A-Za-z0-9_.:-]+$/.test(trimmed)) return trimmed;
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
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;',
  );
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
