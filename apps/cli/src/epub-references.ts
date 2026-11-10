import { posix } from 'node:path';
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';
import { parseSrcset, stringifySrcset } from 'srcset';
import type { Document } from '@xmldom/xmldom';

export interface EpubRelocations {
  files: Map<string, string>;
  anchors: Map<string, Map<string, string>>;
}

export function relativeUri(from: string, to: string): string {
  return posix
    .relative(posix.dirname(from), to)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

export function rewriteUri(
  value: string,
  source: string,
  destination: string,
  moves: EpubRelocations,
): string {
  if (!value || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) return value;
  const base = `https://epub.invalid/${source.split('/').map(encodeURIComponent).join('/')}`;
  const url = new URL(value, base);
  const path = decodeURIComponent(url.pathname.slice(1));
  const fragment = decodeURIComponent(url.hash.slice(1));
  let target = path;
  const visited = new Set<string>();
  while (!visited.has(target)) {
    visited.add(target);
    const next =
      (fragment ? moves.anchors.get(target)?.get(fragment) : undefined) ??
      moves.files.get(target);
    if (!next || next === target) break;
    target = next;
  }
  if (target === path && source === destination) return value;
  return relativeUri(destination, target) + url.search + url.hash;
}

export function rewriteCss(
  source: string,
  from: string,
  to: string,
  moves: EpubRelocations,
  context: 'stylesheet' | 'declarationList' | 'value' = 'stylesheet',
): string {
  let changed = false;
  const ast = parse(source, {
    context,
    onParseError: (error) => {
      throw error;
    },
  });
  walk(ast, {
    visit: 'Url',
    enter(node) {
      const value = rewriteUri(node.value, from, to, moves);
      if (value !== node.value) {
        node.value = value;
        changed = true;
      }
    },
  });
  return changed ? generate(ast) : source;
}

/** Rewrites only URI-bearing attributes and CSS, never article text. */
export function rewriteDocument(
  document: Document,
  from: string,
  to: string,
  moves: EpubRelocations,
  imageTypes: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (
      element.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base') ||
      (element.localName === 'base' && element.hasAttribute('href'))
    )
      throw new Error(
        'EPUB resource rewriting does not support xml:base or HTML base elements.',
      );
    const referencedTypes = new Set<string>();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName ?? attribute.name;
      const original = attribute.value;
      const uri = (value: string) => {
        const next = rewriteUri(value, from, to, moves);
        const resolved = new URL(
          next,
          `https://epub.invalid/${to.split('/').map(encodeURIComponent).join('/')}`,
        );
        const type =
          resolved.origin === 'https://epub.invalid'
            ? imageTypes.get(decodeURIComponent(resolved.pathname.slice(1)))
            : undefined;
        if (type) referencedTypes.add(type);
        else if ((element.getAttribute('type') ?? '').startsWith('image/'))
          referencedTypes.add(element.getAttribute('type')!);
        return next;
      };
      let value = original;
      if (
        ['href', 'src', 'poster', 'data', 'background', 'longdesc'].includes(
          name,
        )
      )
        value = uri(original);
      else if (name === 'srcset' || name === 'imagesrcset') {
        const sources = parseSrcset(original, { strict: true });
        const rewritten = sources.map((entry) => ({
          ...entry,
          url: uri(entry.url),
        }));
        if (sources.some((entry, index) => entry.url !== rewritten[index]!.url))
          value = stringifySrcset(rewritten, { strict: true });
      } else if (name === 'style')
        value = rewriteCss(original, from, to, moves, 'declarationList');
      else if (/\burl\s*\(/i.test(original))
        value = rewriteCss(original, from, to, moves, 'value');
      if (value !== original) {
        attribute.value = value;
        changed = true;
      }
    }
    if (
      element.hasAttribute('type') &&
      (element.getAttribute('type') ?? '').startsWith('image/') &&
      referencedTypes.size
    ) {
      if (referencedTypes.size === 1)
        element.setAttribute('type', [...referencedTypes][0]!);
      else element.removeAttribute('type');
      changed = true;
    }
    if (element.localName === 'style') {
      const original = element.textContent ?? '';
      const value = rewriteCss(original, from, to, moves);
      if (value !== original) {
        element.textContent = value;
        changed = true;
      }
    }
  }
  return changed;
}
