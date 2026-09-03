import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type BlockNode,
  type DocumentAsset,
  type DocumentModel,
  type Equation,
  type InlineNode,
} from '@wordconvert/document-model';
import { builtinHtmlToMarkdown } from 'mithril-markdown-wysiwyg';
import DOMPurify from 'dompurify';
import type { CssNode, List, ListItem } from 'css-tree';

import { markdownToBlocks } from './content-editor.ts';
import type {
  RemoteImageResource,
  RemoteTextFormat,
} from './remote-document.ts';

export interface TextDocumentImportOptions {
  filename: string;
  conversionDate: string;
  sourceUrl?: string;
  resources?: readonly RemoteImageResource[];
  stylesheets?: readonly string[];
}
export interface ImportedTextDocument {
  model: DocumentModel;
  sourceHtml?: { html: string; xhtml: string; css: string };
}

interface PreparedContent {
  markdown: string;
  title?: string;
  language?: string;
  authors?: string[];
  sourceHtml?: { html: string; xhtml: string; css: string };
  assets?: Record<string, DocumentAsset>;
}

export function importTextDocument(
  content: string,
  format: RemoteTextFormat,
  options: TextDocumentImportOptions,
): DocumentModel {
  return importTextDocumentWithSource(content, format, options).model;
}

export function importTextDocumentWithSource(
  content: string,
  format: RemoteTextFormat,
  options: TextDocumentImportOptions,
): ImportedTextDocument {
  return importTextDocumentWithCss(content, format, options, () => '');
}

export async function importRemoteTextDocumentWithSource(
  content: string,
  format: RemoteTextFormat,
  options: TextDocumentImportOptions,
): Promise<ImportedTextDocument> {
  if (format !== 'html')
    return importTextDocumentWithSource(content, format, options);
  const cssTree = await import('css-tree');
  return importTextDocumentWithCss(content, format, options, (styles) =>
    sanitizeEmbeddedCss(styles, cssTree),
  );
}

function importTextDocumentWithCss(
  content: string,
  format: RemoteTextFormat,
  options: TextDocumentImportOptions,
  sanitizeCss: (styles: readonly string[]) => string,
): ImportedTextDocument {
  if (format === 'text') return { model: plainTextModel(content, options) };

  const equations: Record<string, Equation> = {};
  const metadata: PreparedContent =
    format === 'html'
      ? prepareHtml(
          content,
          options.sourceUrl,
          equations,
          options.resources,
          options.stylesheets,
          sanitizeCss,
        )
      : { markdown: prepareMarkdown(content, equations) };
  const base = createModel(options, {
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.language ? { language: metadata.language } : {}),
    authors: metadata.authors ?? [],
    equations,
    ...(metadata.assets ? { assets: metadata.assets } : {}),
  });
  const blocks = replaceEquationPlaceholders(
    markdownToBlocks(metadata.markdown, base),
    equations,
  );
  return {
    model: { ...base, blocks },
    ...(metadata.sourceHtml ? { sourceHtml: metadata.sourceHtml } : {}),
  };
}

export function sanitizeEditedSourceHtml(
  source: string,
  assets: Readonly<Record<string, DocumentAsset>>,
  css: string,
): ImportedTextDocument['sourceHtml'] {
  const document = new DOMParser().parseFromString(source, 'text/html');
  const root = document.body.firstElementChild ?? document.body;
  const assetIdsByDataUrl = new Map(
    Object.values(assets).map((asset) => [assetDataUrl(asset), asset.id]),
  );
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const value = image.getAttribute('src') ?? '';
    const marker = /^wordconvert-asset:([A-Za-z0-9._-]+)$/.exec(value)?.[1];
    const id = marker ?? assetIdsByDataUrl.get(value);
    if (!id || !assets[id]) {
      image.removeAttribute('src');
      return;
    }
    image.dataset.wordconvertAsset = id;
  });
  root
    .querySelectorAll('annotation, annotation-xml')
    .forEach((annotation) => annotation.remove());
  return sanitizedSourceHtml(root as HTMLElement, assets, css);
}

function prepareHtml(
  html: string,
  sourceUrl: string | undefined,
  equations: Record<string, Equation>,
  resources: readonly RemoteImageResource[] = [],
  stylesheets: readonly string[] = [],
  sanitizeCss: (styles: readonly string[]) => string,
): PreparedContent & {
  sourceHtml: { html: string; xhtml: string; css: string };
} {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const css = sanitizeCss(
    [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .concat(stylesheets),
  );
  const root =
    document.querySelector<HTMLElement>('article.ltx_document') ??
    document.querySelector<HTMLElement>('main, article') ??
    document.body;
  root
    .querySelectorAll('script, style, template, noscript')
    .forEach((node) => node.remove());
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const resolved = safeUrl(anchor.getAttribute('href') ?? '', sourceUrl);
    if (resolved) anchor.href = resolved;
    else anchor.removeAttribute('href');
  });
  const assets: Record<string, DocumentAsset> = {};
  const resourcesByUrl = new Map(
    resources.map((resource) => [resource.url, resource]),
  );
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const source = safeImageUrl(image.getAttribute('src') ?? '', sourceUrl);
    const resource = source ? resourcesByUrl.get(source) : undefined;
    if (resource) {
      const id = `remote-image-${String(Object.keys(assets).length + 1).padStart(4, '0')}`;
      const filename = new URL(resource.url).pathname.split('/').at(-1);
      const asset: DocumentAsset = {
        id,
        mediaType: resource.mediaType,
        data: resource.data,
        ...(filename ? { filename } : {}),
      };
      assets[id] = asset;
      image.dataset.wordconvertAsset = id;
      image.src = assetDataUrl(asset);
      return;
    }
    const placeholder = image.ownerDocument.createElement('span');
    placeholder.className = 'source-image-placeholder';
    placeholder.textContent = image.alt.trim() || 'Image omitted';
    image.replaceWith(placeholder);
  });
  root
    .querySelectorAll('annotation, annotation-xml')
    .forEach((annotation) => annotation.remove());
  const sourceHtml = sanitizedSourceHtml(root, assets, css);
  root.querySelectorAll<MathMLElement>('math[alttext]').forEach((math) => {
    const tex = math.getAttribute('alttext')?.trim();
    if (!tex) return;
    const display =
      math.getAttribute('display') === 'block' ? 'block' : 'inline';
    const id = `html-equation-${String(Object.keys(equations).length + 1).padStart(4, '0')}`;
    equations[id] = {
      id,
      source: { format: 'tex', value: tex },
      tex,
      conversionComplete: true,
      display,
    };
    const placeholder = math.ownerDocument.createElement(
      display === 'block' ? 'div' : 'span',
    );
    placeholder.textContent = equationPlaceholder(id);
    math.replaceWith(placeholder);
  });

  const title = documentTitle(
    [
      document
        .querySelector<HTMLMetaElement>('meta[name="citation_title"]')
        ?.content.trim(),
      root.querySelector('h1')?.textContent?.trim(),
      document.title.trim(),
    ],
    sourceUrl,
  );
  const authors = [
    ...document.querySelectorAll<HTMLMetaElement>(
      'meta[name="citation_author"]',
    ),
  ]
    .map(({ content }) => content.trim())
    .filter(Boolean);
  return {
    markdown: builtinHtmlToMarkdown(root.innerHTML),
    sourceHtml,
    assets,
    ...(title ? { title } : {}),
    ...(document.documentElement.lang
      ? { language: document.documentElement.lang }
      : {}),
    ...(authors.length ? { authors } : {}),
  };
}

function documentTitle(
  candidates: readonly (string | undefined)[],
  sourceUrl: string | undefined,
): string | undefined {
  const titles = candidates.filter((value): value is string => Boolean(value));
  const arxivId = arxivIdentifier(sourceUrl);
  if (!arxivId) return titles[0];
  const escapedId = arxivId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifierOnly = new RegExp(
    `^(?:\\[?arxiv:\\s*)?${escapedId}(?:v\\d+)?\\]?$`,
    'i',
  );
  const leadingIdentifier = new RegExp(
    `^\\[?(?:arxiv:\\s*)?${escapedId}(?:v\\d+)?\\]?\\s*[-:|]?\\s*`,
    'i',
  );
  const title = titles
    .map((value) => value.replace(leadingIdentifier, '').trim())
    .find((value) => value && !identifierOnly.test(value));
  return title ? `${title} [${arxivId}]` : arxivId;
}

function arxivIdentifier(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== 'arxiv.org' && url.hostname !== 'www.arxiv.org')
      return undefined;
    const identifier = /^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?$/i.exec(
      url.pathname,
    )?.[1];
    return identifier?.replace(/v\d+$/i, '');
  } catch {
    return undefined;
  }
}

function sanitizedSourceHtml(
  root: HTMLElement,
  assets: Readonly<Record<string, DocumentAsset>>,
  css: string,
): {
  html: string;
  xhtml: string;
  css: string;
} {
  const html = DOMPurify.sanitize(root.outerHTML, {
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'style',
      'link',
      'meta',
      'form',
      'input',
      'button',
      'audio',
      'video',
      'source',
      'track',
      'svg',
    ],
    FORBID_ATTR: ['style', 'src', 'srcset', 'formaction'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const element = parsed.body.firstElementChild;
  element
    ?.querySelectorAll('math')
    .forEach((math) => removeWhitespaceTextNodes(math));
  const htmlElement = element?.cloneNode(true) as Element | undefined;
  const xhtmlElement = element?.cloneNode(true) as Element | undefined;
  applyAssetSources(htmlElement, assets, 'html');
  applyAssetSources(xhtmlElement, assets, 'xhtml');
  return {
    html: htmlElement?.outerHTML ?? html,
    xhtml: xhtmlElement
      ? new XMLSerializer().serializeToString(xhtmlElement)
      : '',
    css,
  };
}

function applyAssetSources(
  root: Element | undefined,
  assets: Readonly<Record<string, DocumentAsset>>,
  format: 'html' | 'xhtml',
): void {
  root
    ?.querySelectorAll<HTMLImageElement>('img[data-wordconvert-asset]')
    .forEach((image) => {
      const id = image.dataset.wordconvertAsset;
      const asset = id ? assets[id] : undefined;
      if (!id || !asset) {
        image.remove();
        return;
      }
      image.setAttribute(
        'src',
        format === 'html' ? assetDataUrl(asset) : `wordconvert-asset:${id}`,
      );
      delete image.dataset.wordconvertAsset;
    });
}

function sanitizeEmbeddedCss(
  styles: readonly string[],
  cssTree: typeof import('css-tree'),
): string {
  const output: string[] = [];
  for (const style of styles) {
    try {
      const ast = cssTree.parse(style, { context: 'stylesheet' });
      cssTree.walk(ast, {
        enter(node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) {
          if (
            node.type === 'Atrule' &&
            ['font-face', 'import', 'namespace'].includes(
              node.name.toLowerCase(),
            )
          ) {
            if (item && list) list.remove(item);
            return;
          }
          if (node.type !== 'Declaration') return;
          const property = node.property.toLowerCase();
          const unsafeProperty =
            property === 'behavior' || property === '-moz-binding';
          const unsafeValue = cssTree.find(
            node.value,
            (value) =>
              value.type === 'Url' ||
              (value.type === 'Function' &&
                value.name.toLowerCase() === 'expression'),
          );
          if ((unsafeProperty || unsafeValue) && item && list)
            list.remove(item);
        },
      });
      output.push(cssTree.generate(ast).replaceAll('<', '\\3c '));
    } catch {
      // Invalid source styles are omitted rather than repaired heuristically.
    }
  }
  return output.join('\n');
}

function safeImageUrl(
  value: string,
  base: string | undefined,
): string | undefined {
  if (!base) return undefined;
  try {
    const source = new URL(base);
    const url = new URL(value, source);
    url.hash = '';
    return url.protocol === 'https:' && url.origin === source.origin
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function assetDataUrl(asset: DocumentAsset): string {
  let binary = '';
  for (let offset = 0; offset < asset.data.length; offset += 0x8000)
    binary += String.fromCharCode(
      ...asset.data.subarray(offset, offset + 0x8000),
    );
  return `data:${asset.mediaType};base64,${btoa(binary)}`;
}

function removeWhitespaceTextNodes(element: Element): void {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim())
      child.remove();
    else if (child.nodeType === Node.ELEMENT_NODE)
      removeWhitespaceTextNodes(child as Element);
  }
}

function prepareMarkdown(
  markdown: string,
  equations: Record<string, Equation>,
): string {
  return markdown.replace(
    /(^|[^\\$])(\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$)/g,
    (
      _match,
      prefix: string,
      _expression: string,
      blockTex: string | undefined,
      inlineTex: string | undefined,
    ) => {
      if (blockTex !== undefined)
        return `${prefix}\n\n${registerEquation(blockTex, 'block', equations)}\n\n`;
      return `${prefix}${registerEquation(inlineTex ?? '', 'inline', equations)}`;
    },
  );
}

function registerEquation(
  value: string,
  display: 'inline' | 'block',
  equations: Record<string, Equation>,
): string {
  const tex = value.trim();
  const id = `html-equation-${String(Object.keys(equations).length + 1).padStart(4, '0')}`;
  equations[id] = {
    id,
    source: { format: 'tex', value: tex },
    tex,
    conversionComplete: true,
    display,
  };
  return equationPlaceholder(id);
}

function createModel(
  options: TextDocumentImportOptions,
  values: {
    title?: string;
    language?: string;
    authors: string[];
    equations: Record<string, Equation>;
    assets?: Record<string, DocumentAsset>;
  },
): DocumentModel {
  const source = options.sourceUrl ?? options.filename;
  const provenance = {
    source,
    method: 'extracted' as const,
    confidence: 'high' as const,
  };
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      ...(values.title ? { title: { value: values.title, provenance } } : {}),
      ...(values.language
        ? { language: { value: values.language, provenance } }
        : {}),
      authors: values.authors.map((name) => ({
        value: { name },
        provenance,
      })),
      subjects: [],
      conversionDate: {
        value: options.conversionDate,
        provenance: {
          source: 'application',
          method: 'default',
          confidence: 'certain',
        },
      },
      ...(options.sourceUrl
        ? { identifier: { value: options.sourceUrl, provenance } }
        : {}),
    },
    blocks: [],
    assets: values.assets ?? {},
    equations: values.equations,
    notes: {},
    styles: [],
    warnings: [],
  };
}

function plainTextModel(
  content: string,
  options: TextDocumentImportOptions,
): DocumentModel {
  const model = createModel(options, { authors: [], equations: {} });
  const blocks: BlockNode[] = content
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((text) => ({
      type: 'paragraph',
      children: [{ type: 'text', text: text.replaceAll(/\s*\n\s*/g, ' ') }],
    }));
  return { ...model, blocks };
}

function replaceEquationPlaceholders(
  blocks: BlockNode[],
  equations: Readonly<Record<string, Equation>>,
): BlockNode[] {
  return blocks.map((block): BlockNode => {
    if (
      block.type === 'paragraph' &&
      block.children.length === 1 &&
      block.children[0]?.type === 'text'
    ) {
      const id = equationId(block.children[0].text);
      if (id && equations[id]?.display === 'block')
        return { type: 'equationBlock', equationId: id };
    }
    if (block.type === 'paragraph' || block.type === 'heading')
      return { ...block, children: replaceInlinePlaceholders(block.children) };
    if (block.type === 'blockquote')
      return {
        ...block,
        blocks: replaceEquationPlaceholders(block.blocks, equations),
      };
    if (block.type === 'list')
      return {
        ...block,
        items: block.items.map((item) => ({
          blocks: replaceEquationPlaceholders(item.blocks, equations),
        })),
      };
    if (block.type === 'table')
      return {
        ...block,
        rows: block.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            ...cell,
            blocks: replaceEquationPlaceholders(cell.blocks, equations),
          })),
        })),
      };
    return block;
  });
}

function replaceInlinePlaceholders(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'link')
      return [{ ...node, children: replaceInlinePlaceholders(node.children) }];
    if (node.type !== 'text') return [node];
    const parts = node.text.split(/(WCQZhtml-equation-\d{4}QZ)/g);
    return parts.flatMap((part): InlineNode[] => {
      const id = equationId(part);
      if (id) return [{ type: 'equation', equationId: id }];
      return part ? [{ ...node, text: part }] : [];
    });
  });
}

function equationPlaceholder(id: string): string {
  return `WCQZ${id}QZ`;
}

function equationId(value: string): string | undefined {
  return /^WCQZ(html-equation-\d{4})QZ$/.exec(value.trim())?.[1];
}

function safeUrl(value: string, base: string | undefined): string | undefined {
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value, base);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'mailto:' && url.pathname) return url.href;
    return undefined;
  } catch {
    return undefined;
  }
}
