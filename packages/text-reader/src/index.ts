import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { marked } from 'marked';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
  type InferredValue,
} from '@wordconvert/document-model';
import {
  contentImageDataUri,
  importContentDataImages,
  markdownToBlocks,
} from './content-editor.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export interface TextReaderOptions {
  filename: string;
  conversionDate: string;
  loadImage?: (
    source: string,
  ) => Promise<{ mediaType: string; data: Uint8Array } | undefined>;
}

function element(node: Node): node is Element {
  return 'tagName' in node;
}
function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function text(node: Node): string {
  return node.nodeName === '#text' && 'value' in node
    ? node.value
    : children(node).map(text).join('');
}
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((entry) => entry.name === name)?.value;
}
function find(
  node: Node,
  predicate: (value: Element) => boolean,
): Element | undefined {
  if (element(node) && predicate(node)) return node;
  for (const child of children(node)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return undefined;
}
function escaped(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([*_[\]<>`|])/g, '\\$1');
}
function inferred<T>(value: T): InferredValue<T> {
  return {
    value,
    provenance: {
      source: 'Text document',
      method: 'extracted',
      confidence: 'high',
    },
  };
}

export async function readTextDocument(
  source: string,
  format: 'markdown' | 'html',
  options: TextReaderOptions,
): Promise<DocumentModel> {
  if (new TextEncoder().encode(source).byteLength > 50 * 1024 * 1024)
    throw new Error('Text document exceeds the 50 MiB input limit.');
  const document = parse(
    format === 'markdown'
      ? marked.parse(source, { async: false, gfm: true })
      : source,
  );
  const root =
    find(
      document,
      (node) =>
        node.tagName === 'main' ||
        attribute(node, 'role')?.split(/\s+/).includes('main') === true ||
        attribute(node, 'id') === 'main',
    ) ??
    find(document, (node) => attribute(node, 'id') === 'content') ??
    find(document, (node) => node.tagName === 'article') ??
    find(document, (node) => node.tagName === 'body') ??
    document;
  const language = find(
    document,
    (node) => node.tagName === 'html',
  )?.attrs.find((entry) => entry.name === 'lang')?.value;
  const titleNode =
    find(document, (node) => node.tagName === 'title') ??
    find(root, (node) => node.tagName === 'h1');
  const title = titleNode
    ? text(titleNode).trim()
    : options.filename.replace(/\.[^.]+$/, '');
  let model: DocumentModel = {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      ...(title ? { title: inferred(title) } : {}),
      ...(language ? { language: inferred(language) } : {}),
      authors: [],
      subjects: [],
      conversionDate: {
        value: options.conversionDate,
        provenance: {
          source: 'CLI conversion date',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks: [],
    styles: [],
    assets: {},
    equations: {},
    notes: {},
    warnings: [],
  };
  const warnings = new Set<string>();
  const warn = (code: string, message: string) => {
    if (warnings.has(code)) return;
    warnings.add(code);
    model.warnings.push({ code, severity: 'warning', message });
  };
  const imageSources = new Map<string, string>();
  let imageCount = 0;
  let totalImageBytes = 0;
  async function collect(node: Node, depth = 0): Promise<void> {
    if (depth > 128)
      throw new Error('Text document nesting exceeds 128 levels.');
    if (element(node)) {
      if (
        [
          'script',
          'style',
          'iframe',
          'object',
          'embed',
          'template',
          'noscript',
          'svg',
          'form',
          'input',
          'button',
        ].includes(node.tagName)
      ) {
        warn(
          'text-active-content-omitted',
          'Active elements, embedded styles, or interactive controls were omitted from the semantic output.',
        );
        return;
      }
      if (node.tagName === 'meta' && attribute(node, 'name') === 'author') {
        const author = attribute(node, 'content');
        if (author?.trim())
          model.metadata.authors.push(inferred({ name: author.trim() }));
      }
      if (node.tagName === 'img') {
        const src = attribute(node, 'src') ?? '';
        if (!imageSources.has(src)) {
          if (++imageCount > 100)
            throw new Error('Text document exceeds the 100 image limit.');
          if (src.startsWith('data:')) {
            if (src.length > 14 * 1024 * 1024)
              throw new Error('Embedded image exceeds its size limit.');
            imageSources.set(src, src);
          } else {
            const resource = await options.loadImage?.(src);
            if (resource) {
              totalImageBytes += resource.data.byteLength;
              if (
                resource.data.byteLength > 10 * 1024 * 1024 ||
                totalImageBytes > 50 * 1024 * 1024
              )
                throw new Error(
                  'Text document images exceed their size limits.',
                );
              let binary = '';
              for (
                let offset = 0;
                offset < resource.data.length;
                offset += 0x8000
              )
                binary += String.fromCharCode(
                  ...resource.data.subarray(offset, offset + 0x8000),
                );
              imageSources.set(
                src,
                `data:${resource.mediaType};base64,${btoa(binary)}`,
              );
            } else {
              imageSources.set(src, '');
              warn(
                'text-image-omitted',
                'An unavailable, remote, or unsupported image was omitted; its alternative text was retained.',
              );
            }
          }
        }
      }
    }
    for (const child of children(node)) await collect(child, depth + 1);
  }
  await collect(document);
  const equation = (value: string, display: 'inline' | 'block') => {
    const id = `text-equation-${Object.keys(model.equations).length + 1}`;
    model.equations[id] = {
      id,
      source: { format: 'tex', value },
      tex: value,
      display,
      conversionComplete: true,
    };
    return `<span data-wordconvert-equation-id="${id}" data-wordconvert-display="${display}">${display === 'block' ? `$$\n${value}\n$$` : `$${value}$`}</span>`;
  };
  function render(node: Node, depth = 0): string {
    if (depth > 128)
      throw new Error('Text document nesting exceeds 128 levels.');
    if (!element(node))
      return node.nodeName === '#text'
        ? escaped(text(node).replace(/\s+/g, ' '))
        : children(node)
            .map((child) => render(child, depth + 1))
            .join('');
    const tag = node.tagName;
    if (
      [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'template',
        'noscript',
        'svg',
        'form',
        'input',
        'button',
      ].includes(tag)
    ) {
      warn(
        'text-active-content-omitted',
        'Active elements, embedded styles, or interactive controls were omitted from the semantic output.',
      );
      return '';
    }
    if (
      node.attrs.some(
        (entry) => entry.name === 'style' || entry.name.startsWith('on'),
      )
    )
      warn(
        'text-style-omitted',
        'Source styling or event handlers were omitted; semantic formatting is preserved.',
      );
    if (tag === 'pre') {
      const value = text(node).replace(/\n$/, '');
      const fence = '`'.repeat(
        Math.max(
          3,
          ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1),
        ),
      );
      return `\n\n${fence}\n${value}\n${fence}\n\n`;
    }
    if (tag === 'code') {
      const value = text(node);
      const fence = '`'.repeat(
        Math.max(
          1,
          ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1),
        ),
      );
      return `${fence} ${value} ${fence}`;
    }
    if (tag === 'math') {
      const tex = attribute(node, 'alttext');
      if (tex)
        return equation(
          tex,
          attribute(node, 'display') === 'block' ? 'block' : 'inline',
        );
      warn(
        'text-math-omitted',
        'MathML without a TeX alternative was retained as text.',
      );
      return escaped(text(node));
    }
    const body = children(node)
      .map((child) => render(child, depth + 1))
      .join('');
    if (/^h[1-6]$/.test(tag)) {
      const id = attribute(node, 'id');
      const anchor =
        id && /^[A-Za-z][A-Za-z0-9._:-]*$/.test(id)
          ? `<a id="${id}"></a>\n\n`
          : '';
      return `\n\n${anchor}${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    }
    if (['strong', 'b'].includes(tag)) return `**${body}**`;
    if (['em', 'i'].includes(tag)) return `*${body}*`;
    if (['s', 'del'].includes(tag)) return `~~${body}~~`;
    if (tag === 'br') return '  \n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'img') {
      const src = imageSources.get(attribute(node, 'src') ?? '');
      const alt = escaped(attribute(node, 'alt') ?? 'Image');
      return src ? `![${alt}](<${src}>)` : alt;
    }
    if (tag === 'a') {
      const href = attribute(node, 'href') ?? '';
      if (/^(?:https?:|mailto:|#)/i.test(href) && !/[\s<>]/.test(href))
        return `[${body}](<${href}>)`;
      if (href)
        warn(
          'text-link-omitted',
          'A relative or unsafe link destination was omitted; link text was retained.',
        );
      return body;
    }
    if (tag === 'ul' || tag === 'ol') {
      let index = Number(attribute(node, 'start') ?? '1');
      if (!Number.isSafeInteger(index) || index < 1) index = 1;
      return (
        '\n\n' +
        children(node)
          .filter(
            (child): child is Element =>
              element(child) && child.tagName === 'li',
          )
          .map((item) => {
            const marker = tag === 'ol' ? `${index++}. ` : '- ';
            return (
              marker +
              children(item)
                .map((child) => render(child, depth + 1))
                .join('')
                .trim()
                .replace(/\n/g, `\n${' '.repeat(marker.length)}`)
            );
          })
          .join('\n') +
        '\n\n'
      );
    }
    if (tag === 'blockquote')
      return (
        '\n\n' +
        body
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n') +
        '\n\n'
      );
    if (tag === 'table') {
      const rows: Element[] = [];
      const visit = (value: Node) => {
        if (element(value) && value.tagName === 'tr') rows.push(value);
        else for (const child of children(value)) visit(child);
      };
      for (const child of children(node)) visit(child);
      const cells = rows.map((row) =>
        children(row)
          .filter(
            (child): child is Element =>
              element(child) && ['td', 'th'].includes(child.tagName),
          )
          .map((cell) => {
            if (attribute(cell, 'colspan') || attribute(cell, 'rowspan'))
              warn(
                'text-table-spans-omitted',
                'HTML table row/column spans were flattened.',
              );
            return children(cell)
              .map((child) => render(child, depth + 1))
              .join('')
              .trim()
              .replace(/\n/g, ' ');
          }),
      );
      const width = Math.max(0, ...cells.map((row) => row.length));
      if (!width) return '';
      const row = (values: string[]) =>
        `| ${Array.from({ length: width }, (_, index) => values[index] ?? '').join(' | ')} |`;
      return `\n\n${row(cells[0] ?? [])}\n${row(Array.from({ length: width }, () => '---'))}\n${cells.slice(1).map(row).join('\n')}\n\n`;
    }
    if (
      [
        'p',
        'div',
        'section',
        'article',
        'main',
        'header',
        'footer',
        'figure',
        'figcaption',
      ].includes(tag)
    )
      return `\n\n${body.trim()}\n\n`;
    return body;
  }
  let markdown = format === 'markdown' ? source : render(root).trim();
  // Preserve Markdown math only outside fenced/inline code produced by the renderer.
  if (format === 'markdown') {
    markdown = markdown
      .split(/(`{3,}[\s\S]*?`{3,}|`+[^`]*`+)/g)
      .map((part, index) =>
        index % 2
          ? part
          : part.replace(
              /(^|[^\\$])(\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$)/g,
              (
                _match,
                prefix: string,
                _expression: string,
                block: string | undefined,
                inline: string | undefined,
              ) =>
                `${prefix}${equation((block ?? inline ?? '').trim(), block === undefined ? 'inline' : 'block')}`,
            ),
      )
      .join('');
  }
  const imported = importContentDataImages(
    [...imageSources.values()]
      .filter(Boolean)
      .map((url) => `![](<${url}>)`)
      .join('\n\n'),
    model,
  );
  if (!imported.ok) throw new Error(imported.message);
  model = imported.model;
  const assetIds = new Map(
    Object.values(model.assets).map((asset) => [
      contentImageDataUri(asset.mediaType, asset.data),
      asset.id,
    ]),
  );
  const aliases = new Map<string, string>();
  for (const [source, url] of imageSources) {
    const id = assetIds.get(url);
    if (id) aliases.set(source, id);
  }
  model.blocks = markdownToBlocks(markdown, model, aliases);
  return model;
}
