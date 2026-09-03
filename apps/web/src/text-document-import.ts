import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type BlockNode,
  type DocumentModel,
  type Equation,
  type InlineNode,
} from '@wordconvert/document-model';
import { builtinHtmlToMarkdown } from 'mithril-markdown-wysiwyg';
import DOMPurify from 'dompurify';

import { markdownToBlocks } from './content-editor.ts';
import type { RemoteTextFormat } from './remote-document.ts';

export interface TextDocumentImportOptions {
  filename: string;
  conversionDate: string;
  sourceUrl?: string;
}
export interface ImportedTextDocument {
  model: DocumentModel;
  sourceHtml?: { html: string; xhtml: string };
}

interface PreparedContent {
  markdown: string;
  title?: string;
  language?: string;
  authors?: string[];
  sourceHtml?: { html: string; xhtml: string };
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
  if (format === 'text') return { model: plainTextModel(content, options) };

  const equations: Record<string, Equation> = {};
  const metadata: PreparedContent =
    format === 'html'
      ? prepareHtml(content, options.sourceUrl, equations)
      : { markdown: prepareMarkdown(content, equations) };
  const base = createModel(options, {
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.language ? { language: metadata.language } : {}),
    authors: metadata.authors ?? [],
    equations,
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

function prepareHtml(
  html: string,
  sourceUrl: string | undefined,
  equations: Record<string, Equation>,
): PreparedContent & { sourceHtml: { html: string; xhtml: string } } {
  const document = new DOMParser().parseFromString(html, 'text/html');
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
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const placeholder = image.ownerDocument.createElement('span');
    placeholder.className = 'source-image-placeholder';
    placeholder.textContent = image.alt.trim() || 'Image omitted';
    image.replaceWith(placeholder);
  });
  root
    .querySelectorAll('annotation, annotation-xml')
    .forEach((annotation) => annotation.remove());
  const sourceHtml = sanitizedSourceHtml(root);
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

  const title =
    document
      .querySelector<HTMLMetaElement>('meta[name="citation_title"]')
      ?.content.trim() ||
    root.querySelector('h1')?.textContent?.trim() ||
    document.title.trim() ||
    undefined;
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
    ...(title ? { title } : {}),
    ...(document.documentElement.lang
      ? { language: document.documentElement.lang }
      : {}),
    ...(authors.length ? { authors } : {}),
  };
}

function sanitizedSourceHtml(root: HTMLElement): {
  html: string;
  xhtml: string;
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
  return {
    html,
    xhtml: element ? new XMLSerializer().serializeToString(element) : '',
  };
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
    assets: {},
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
