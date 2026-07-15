import { fail } from './error.ts';
import { strFromU8 } from 'fflate';

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlNode | string>;
}

const entities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(#x[\da-f]+|#\d+|\w+);/gi,
    (_match, entity: string) => {
      if (entity.startsWith('#x'))
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith('#'))
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return (
        entities[entity] ??
        fail('invalid-input', 'XML contains an undeclared entity.')
      );
    },
  );
}

function findTagEnd(xml: string, start: number): number {
  let quote = '';
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index] ?? '';
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function parseTag(source: string): {
  name: string;
  attributes: Record<string, string>;
} {
  const match = /^([^\s/>]+)([\s\S]*)$/.exec(source.trim());
  if (!match) fail('invalid-input', 'XML contains an invalid element.');
  const attributes: Record<string, string> = {};
  const rest = match[2] ?? '';
  const attributePattern = /([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g;
  let consumed = '';
  for (const attribute of rest.matchAll(attributePattern)) {
    consumed += attribute[0];
    const raw = attribute[2] ?? '';
    attributes[attribute[1] ?? ''] = decodeEntities(raw.slice(1, -1));
  }
  if (rest.replace(attributePattern, '').trim())
    fail('invalid-input', 'XML contains an invalid attribute.');
  return { name: match[1] ?? '', attributes };
}

export function parseXml(bytes: Uint8Array, part: string): XmlNode {
  let xml: string;
  try {
    xml = strFromU8(bytes);
  } catch {
    return fail('invalid-input', 'An XML package part is not valid UTF-8.', {
      part,
    });
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return fail(
      'invalid-input',
      'DTD and entity declarations are not allowed in DOCX XML.',
      { part },
    );
  }
  const root: XmlNode = { name: '#document', attributes: {}, children: [] };
  const stack = [root];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open < 0) {
      const tail = decodeEntities(xml.slice(cursor));
      if (tail) stack.at(-1)?.children.push(tail);
      break;
    }
    const text = decodeEntities(xml.slice(cursor, open));
    if (text) stack.at(-1)?.children.push(text);
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end < 0)
        fail('invalid-input', 'XML contains an unterminated comment.', {
          part,
        });
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end < 0)
        fail('invalid-input', 'XML contains an unterminated declaration.', {
          part,
        });
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      if (end < 0)
        fail('invalid-input', 'XML contains unterminated CDATA.', { part });
      stack.at(-1)?.children.push(xml.slice(open + 9, end));
      cursor = end + 3;
      continue;
    }
    const end = findTagEnd(xml, open + 1);
    if (end < 0)
      fail('invalid-input', 'XML contains an unterminated element.', { part });
    const source = xml.slice(open + 1, end).trim();
    if (source.startsWith('/')) {
      const expected = source.slice(1).trim();
      const current = stack.pop();
      if (!current || current === root || current.name !== expected)
        fail('invalid-input', 'XML elements are not properly nested.', {
          part,
        });
    } else {
      const selfClosing = source.endsWith('/');
      const parsed = parseTag(selfClosing ? source.slice(0, -1) : source);
      const node: XmlNode = { ...parsed, children: [] };
      stack.at(-1)?.children.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }
  if (stack.length !== 1)
    fail('invalid-input', 'XML contains an unclosed element.', { part });
  const documentElements = root.children.filter(isNode);
  if (documentElements.length !== 1)
    fail('invalid-input', 'XML must contain one document element.', { part });
  return documentElements[0] as XmlNode;
}

export function isNode(value: XmlNode | string): value is XmlNode {
  return typeof value !== 'string';
}

export function localName(node: XmlNode): string {
  return node.name.includes(':')
    ? (node.name.split(':').at(-1) ?? node.name)
    : node.name;
}

export function elements(node: XmlNode, name?: string): XmlNode[] {
  const result = node.children.filter(isNode);
  return name ? result.filter((child) => localName(child) === name) : result;
}

export function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const child of elements(node)) {
    if (localName(child) === name) found.push(child);
    found.push(...descendants(child, name));
  }
  return found;
}

export function first(node: XmlNode, name: string): XmlNode | undefined {
  return elements(node, name)[0];
}

export function attribute(node: XmlNode, name: string): string | undefined {
  return Object.entries(node.attributes).find(
    ([key]) => key === name || key.endsWith(`:${name}`),
  )?.[1];
}

export function textContent(node: XmlNode): string {
  return node.children
    .map((child) => (isNode(child) ? textContent(child) : child))
    .join('');
}
