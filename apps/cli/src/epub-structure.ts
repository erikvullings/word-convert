import { posix } from 'node:path';
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
  type Node,
} from '@xmldom/xmldom';
import { strToU8 } from 'fflate';
import {
  relativeUri,
  rewriteCss,
  rewriteDocument,
  type EpubRelocations,
} from './epub-references.ts';

const OPF = 'http://www.idpf.org/2007/opf';
const XHTML = 'http://www.w3.org/1999/xhtml';
const EPUB = 'http://www.idpf.org/2007/ops';
const NCX = 'http://www.daisy.org/z3986/2005/ncx/';
const serializer = new XMLSerializer();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function readEpubXml(
  bytes: Uint8Array | undefined,
  name: string,
  content = false,
  warn?: (message: string) => void,
): Document {
  if (!bytes) throw new Error(`EPUB is missing ${name}.`);
  if (bytes.length > (content ? 32 : 4) * 1024 * 1024)
    throw new Error(
      `EPUB XML exceeds the ${content ? 32 : 4} MiB document limit.`,
    );
  const source = decoder.decode(bytes);
  if (
    /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source) ||
    (!content && /<!DOCTYPE/i.test(source))
  )
    throw new Error('EPUB XML DTD/entity declarations are not supported.');
  const document = new DOMParser({
    onError: (level, message) => {
      if (
        level === 'warning' &&
        message.startsWith('Unicode replacement character detected') &&
        warn
      ) {
        warn(
          `warning: ${name} contains existing Unicode replacement characters; text is preserved.\n`,
        );
        return;
      }
      throw new Error(`${name}: ${message}`);
    },
  }).parseFromString(source, 'application/xml');
  for (const element of Array.from(document.getElementsByTagName('*')))
    if (
      element.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base') ||
      (element.localName === 'base' && element.hasAttribute('href'))
    )
      throw new Error(
        'EPUB rewriting does not support xml:base or HTML base elements.',
      );
  return document;
}

export function localEpubPath(packagePath: string, href: string): string {
  if (
    !href ||
    /^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(href) ||
    href.includes('?') ||
    href.includes('#')
  )
    throw new Error('EPUB manifest resource must be a local relative path.');
  const decoded = decodeURIComponent(href);
  const path = posix.join(posix.dirname(packagePath), decoded);
  if (
    path.startsWith('../') ||
    path.startsWith('/') ||
    /[\\\p{Cc}]/u.test(path)
  )
    throw new Error('EPUB manifest resource escapes the archive.');
  return path;
}

function elements(
  document: Document,
  namespace: string,
  name: string,
): Element[] {
  return Array.from(document.getElementsByTagNameNS(namespace, name));
}
function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function hasProperty(item: Element, property: string) {
  return (item.getAttribute('properties') ?? '')
    .split(/\s+/)
    .includes(property);
}
function headingLevel(element: Element): number {
  return element.namespaceURI === XHTML &&
    /^h[1-6]$/.test(element.localName ?? '')
    ? Number(element.localName!.slice(1))
    : 0;
}

export class EpubStructure {
  hasStructuralChanges = false;
  readonly documents = new Map<string, Document>();
  readonly moves: EpubRelocations = { files: new Map(), anchors: new Map() };
  readonly imageTypes = new Map<string, string>();
  private readonly sources = new Map<string, string>();
  private readonly changed = new Set<string>();

  constructor(
    private readonly entries: Record<string, Uint8Array>,
    private readonly packages: ReadonlyMap<string, Document>,
    private readonly warn: (message: string) => void,
  ) {
    for (const [path, document] of packages) this.documents.set(path, document);
  }

  uniquePath(preferred: string): string {
    const extension = posix.extname(preferred);
    const stem = preferred.slice(0, preferred.length - extension.length);
    let path = preferred,
      index = 1;
    while (
      this.entries[path] ||
      this.documents.has(path) ||
      [...this.moves.files.values()].includes(path)
    )
      path = `${stem}-${index++}${extension}`;
    return path;
  }

  private document(path: string): Document {
    const existing = this.documents.get(path);
    if (existing) return existing;
    const document = readEpubXml(this.entries[path], path, true, this.warn);
    this.documents.set(path, document);
    return document;
  }

  markPackage(path: string) {
    this.changed.add(path);
  }

  private spine(packagePath: string, document: Document) {
    const items = new Map(
      elements(document, OPF, 'item').map((item) => [
        item.getAttribute('id'),
        item,
      ]),
    );
    return elements(document, OPF, 'itemref').flatMap((reference) => {
      const item = items.get(reference.getAttribute('idref'));
      if (
        !item ||
        item.getAttribute('media-type') !== 'application/xhtml+xml' ||
        hasProperty(item, 'nav')
      )
        return [];
      const path = localEpubPath(packagePath, item.getAttribute('href') ?? '');
      return [{ item, reference, path }];
    });
  }

  private splitDocument(path: string): string[] {
    const source = this.document(path);
    const body = elements(source, XHTML, 'body')[0];
    if (!body) return [path];
    if (body.parentNode !== source.documentElement)
      throw new Error(
        'EPUB chapter splitting requires an XHTML body directly under html.',
      );
    const headings = Array.from(body.getElementsByTagName('*')).filter((node) =>
      headingLevel(node),
    );
    const count = (level: number) =>
      headings.filter((node) => headingLevel(node) === level).length;
    const level = count(1) >= 2 ? 1 : count(2) >= 2 ? 2 : 0;
    if (!level) return [path];
    const parts: Document[] = [];
    let targets: Node[] = [];
    const ancestors: Element[] = [];
    let current!: Document;
    let meaningful = false;
    const start = () => {
      const previousTargets = targets;
      if (parts.length >= 10000)
        throw new Error(
          'EPUB chapter splitting exceeds the 10000 chapter limit.',
        );
      current = source.cloneNode(false) as Document;
      for (const child of Array.from(source.childNodes)) {
        if (child === source.documentElement) {
          const root = current.importNode(child, false);
          for (const content of Array.from(child.childNodes))
            root.appendChild(current.importNode(content, content !== body));
          current.appendChild(root);
        } else current.appendChild(current.importNode(child, true));
      }
      const target = elements(current, XHTML, 'body')[0]!;
      while (target.firstChild) target.removeChild(target.firstChild);
      if (parts.length) target.removeAttribute('id');
      targets = [target];
      for (const [index, ancestor] of ancestors.entries()) {
        const clone = current.importNode(ancestor, false);
        const previous = previousTargets[index + 1] as Element | undefined;
        const hasContent =
          previous?.textContent?.trim() ||
          Array.from(previous?.getElementsByTagName('*') ?? []).some(
            (element) =>
              ['img', 'svg', 'math', 'hr', 'object', 'video', 'audio'].includes(
                element.localName ?? '',
              ),
          );
        if (hasContent) clone.removeAttribute('id');
        else previous?.removeAttribute('id');
        targets.at(-1)!.appendChild(clone);
        targets.push(clone);
      }
      parts.push(current);
      meaningful = false;
    };
    start();
    const append = (node: Node) => {
      if (node.nodeType === 1) {
        const element = node as Element;
        if (headingLevel(element) === level) {
          if (meaningful) start();
          targets.at(-1)!.appendChild(current.importNode(element, true));
          meaningful = true;
          return;
        }
        const clone = current.importNode(element, false);
        targets.at(-1)!.appendChild(clone);
        ancestors.push(element);
        targets.push(clone);
        if (
          ['img', 'svg', 'math', 'hr', 'object', 'video', 'audio'].includes(
            element.localName ?? '',
          )
        )
          meaningful = true;
        for (const child of Array.from(element.childNodes)) append(child);
        ancestors.pop();
        targets.pop();
      } else {
        targets.at(-1)!.appendChild(current.importNode(node, true));
        if (node.nodeType === 3 && node.textContent?.trim()) meaningful = true;
      }
    };
    for (const child of Array.from(body.childNodes)) append(child);
    if (parts.length < 2) return [path];
    this.hasStructuralChanges = true;
    const paths = parts.map((_part, index) =>
      index === 0
        ? path
        : this.uniquePath(
            `${path.slice(0, -posix.extname(path).length)}-chapter-${String(index + 1).padStart(3, '0')}.xhtml`,
          ),
    );
    const anchors = new Map<string, string>();
    parts.forEach((part, index) => {
      const destination = paths[index]!;
      for (const element of Array.from(part.getElementsByTagName('*'))) {
        const id = element.getAttribute('id');
        if (id && !anchors.has(id)) anchors.set(id, destination);
      }
      this.documents.set(destination, part);
      this.sources.set(destination, path);
      this.changed.add(destination);
    });
    this.moves.anchors.set(path, anchors);
    return paths;
  }

  splitChapters() {
    const splits = new Map<string, string[]>();
    for (const [packagePath, document] of this.packages) {
      const spine = this.spine(packagePath, document);
      const ids = new Set(
        elements(document, OPF, 'item').map((item) => item.getAttribute('id')),
      );
      for (const { item, reference, path } of spine) {
        let paths = splits.get(path);
        if (!paths) {
          paths = this.splitDocument(path);
          splits.set(path, paths);
        }
        let previousItem: Node = item,
          previousReference: Node = reference;
        paths.slice(1).forEach((destination, index) => {
          const clone = item.cloneNode(true) as Element;
          let id = `${item.getAttribute('id')}-chapter-${index + 2}`;
          while (ids.has(id)) id += '-split';
          ids.add(id);
          clone.setAttribute('id', id);
          clone.setAttribute('href', relativeUri(packagePath, destination));
          previousItem.parentNode!.insertBefore(
            clone,
            previousItem.nextSibling,
          );
          previousItem = clone;
          const nextReference = reference.cloneNode(true) as Element;
          nextReference.removeAttribute('id');
          nextReference.setAttribute('idref', id);
          previousReference.parentNode!.insertBefore(
            nextReference,
            previousReference.nextSibling,
          );
          previousReference = nextReference;
          this.changed.add(packagePath);
        });
      }
    }
  }

  addMissingToc() {
    for (const [packagePath, document] of this.packages) {
      const items = elements(document, OPF, 'item');
      const version3 = (
        document.documentElement?.getAttribute('version') ?? ''
      ).startsWith('3');
      const missingNavigation: Element[] = [];
      const existing = items.find((item) => {
        if (
          version3
            ? !hasProperty(item, 'nav')
            : item.getAttribute('media-type') !== 'application/x-dtbncx+xml'
        )
          return false;
        const path = localEpubPath(
          packagePath,
          item.getAttribute('href') ?? '',
        );
        if (!this.entries[path] && !this.documents.has(path)) {
          missingNavigation.push(item);
          return false;
        }
        const content = this.document(path);
        return version3
          ? elements(content, XHTML, 'nav').some(
              (nav) =>
                (nav.getAttributeNS(EPUB, 'type') ?? '')
                  .split(/\s+/)
                  .includes('toc') &&
                nav.getElementsByTagNameNS(XHTML, 'a').length > 0,
            )
          : elements(content, NCX, 'navPoint').length > 0;
      });
      if (existing) {
        const spine = elements(document, OPF, 'spine')[0];
        if (
          !version3 &&
          spine &&
          spine.getAttribute('toc') !== existing.getAttribute('id')
        ) {
          spine.setAttribute('toc', existing.getAttribute('id')!);
          this.hasStructuralChanges = true;
          this.changed.add(packagePath);
        }
        continue;
      }
      const links: { path: string; id: string; title: string }[] = [];
      const fallback: typeof links = [];
      for (const { path } of this.spine(packagePath, document)) {
        const content = this.document(path);
        const body = elements(content, XHTML, 'body')[0];
        if (!body) continue;
        const ids = new Set(
          Array.from(content.getElementsByTagName('*')).map((element) =>
            element.getAttribute('id'),
          ),
        );
        let number = 1;
        for (const heading of Array.from(body.getElementsByTagName('*')).filter(
          (node) => headingLevel(node),
        )) {
          const title = heading.textContent?.replace(/\s+/g, ' ').trim();
          if (!title) continue;
          let id = heading.getAttribute('id') ?? '';
          if (!id) {
            do {
              id = `wordconvert-heading-${number++}`;
            } while (ids.has(id));
            ids.add(id);
            heading.setAttribute('id', id);
            this.changed.add(path);
          }
          links.push({ path, id, title });
        }
        fallback.push({
          path,
          id: '',
          title:
            elements(content, XHTML, 'title')[0]?.textContent?.trim() ||
            posix.basename(path),
        });
      }
      if (!links.length) {
        links.push(...fallback);
        this.warn(
          'warning: EPUB has no usable headings; generated TOC lists spine documents.\n',
        );
      }
      if (!links.length) {
        this.warn(
          'warning: Cannot generate an EPUB TOC: no readable XHTML spine documents.\n',
        );
        continue;
      }
      const title =
        document.getElementsByTagNameNS(
          'http://purl.org/dc/elements/1.1/',
          'title',
        )[0]?.textContent ?? 'Contents';
      const navPath = this.uniquePath(
        posix.join(
          posix.dirname(packagePath),
          version3 ? 'wordconvert-nav.xhtml' : 'wordconvert-toc.ncx',
        ),
      );
      const href = (entry: (typeof links)[number]) =>
        escapeXml(
          relativeUri(navPath, entry.path) +
            (entry.id ? `#${encodeURIComponent(entry.id)}` : ''),
        );
      const uidId = document.documentElement?.getAttribute('unique-identifier');
      const uid = uidId
        ? (Array.from(document.getElementsByTagName('*')).find(
            (element) => element.getAttribute('id') === uidId,
          )?.textContent ?? '')
        : '';
      const xml = version3
        ? `<html xmlns="${XHTML}" xmlns:epub="${EPUB}"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${links.map((entry) => `<li><a href="${href(entry)}">${escapeXml(entry.title)}</a></li>`).join('')}</ol></nav></body></html>`
        : `<ncx xmlns="${NCX}" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(uid)}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${links.map((entry, index) => `<navPoint id="nav-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(entry.title)}</text></navLabel><content src="${href(entry)}"/></navPoint>`).join('')}</navMap></ncx>`;
      this.documents.set(
        navPath,
        readEpubXml(strToU8(xml), navPath, true, this.warn),
      );
      this.hasStructuralChanges = true;
      this.changed.add(navPath);
      const ids = new Set(items.map((item) => item.getAttribute('id')));
      const missingId = missingNavigation[0]?.getAttribute('id');
      let id = missingId || 'wordconvert-navigation';
      while (ids.has(id) && id !== missingId) id += '-new';
      const item = document.createElementNS(OPF, 'item');
      item.setAttribute('id', id);
      item.setAttribute('href', relativeUri(packagePath, navPath));
      item.setAttribute(
        'media-type',
        version3 ? 'application/xhtml+xml' : 'application/x-dtbncx+xml',
      );
      if (version3) {
        item.setAttribute('properties', 'nav');
        for (const previous of items.filter((entry) =>
          hasProperty(entry, 'nav'),
        )) {
          const properties = (previous.getAttribute('properties') ?? '')
            .split(/\s+/)
            .filter((value) => value && value !== 'nav')
            .join(' ');
          if (properties) previous.setAttribute('properties', properties);
          else previous.removeAttribute('properties');
        }
      } else elements(document, OPF, 'spine')[0]?.setAttribute('toc', id);
      const manifest = elements(document, OPF, 'manifest')[0];
      if (!manifest) throw new Error('EPUB package has no manifest.');
      for (const missing of missingNavigation) {
        this.moves.files.set(
          localEpubPath(packagePath, missing.getAttribute('href') ?? ''),
          navPath,
        );
        for (const reference of elements(document, OPF, 'itemref'))
          if (
            missing.getAttribute('id') !== id &&
            reference.getAttribute('idref') === missing.getAttribute('id')
          )
            reference.parentNode?.removeChild(reference);
        missing.parentNode?.removeChild(missing);
      }
      manifest.appendChild(item);
      this.changed.add(packagePath);
    }
  }

  finish(): boolean {
    if (this.moves.files.size || this.moves.anchors.size) {
      const xmlPaths = new Set(
        Object.keys(this.entries).filter((path) =>
          /\.(?:xhtml|html|htm|svg|ncx|opf|smil)$/i.test(path),
        ),
      );
      const cssPaths = new Set(
        Object.keys(this.entries).filter((path) => /\.css$/i.test(path)),
      );
      for (const [packagePath, document] of this.packages)
        for (const item of elements(document, OPF, 'item')) {
          const href = item.getAttribute('href') ?? '';
          if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
          const path = localEpubPath(packagePath, href);
          const type = item.getAttribute('media-type') ?? '';
          if (
            [
              'application/xhtml+xml',
              'image/svg+xml',
              'application/x-dtbncx+xml',
              'application/smil+xml',
            ].includes(type)
          )
            xmlPaths.add(path);
          if (type === 'text/css') cssPaths.add(path);
        }
      for (const path of xmlPaths) this.document(path);
      if (
        Object.keys(this.entries).some((path) =>
          /\.(?:m?js|cjs)$/i.test(path),
        ) ||
        [...this.documents.values()].some((document) =>
          Array.from(document.getElementsByTagName('*')).some(
            (element) =>
              element.localName?.toLowerCase() === 'script' ||
              (element.localName === 'item' &&
                (hasProperty(element, 'scripted') ||
                  /javascript/i.test(
                    element.getAttribute('media-type') ?? '',
                  ))) ||
              Array.from(element.attributes).some(
                (attribute) =>
                  /^on[a-z]/i.test(attribute.name) ||
                  /^\s*javascript:/i.test(attribute.value),
              ),
          ),
        )
      )
        throw new Error(
          'Cannot relocate resources or split chapters in a scripted EPUB: dynamic references cannot be rewritten safely. Omit --split-chapters and use --image-format preserve or --max-image-size 0.',
        );
      for (const [path, document] of this.documents)
        if (
          rewriteDocument(
            document,
            this.sources.get(path) ?? path,
            path,
            this.moves,
            this.imageTypes,
          )
        )
          this.changed.add(path);
      for (const path of cssPaths) {
        const original = decoder.decode(this.entries[path]);
        const rewritten = rewriteCss(original, path, path, this.moves);
        if (rewritten !== original) {
          this.entries[path] = strToU8(rewritten);
          this.changed.add(path);
        }
      }
    }
    for (const path of this.changed) {
      const document = this.documents.get(path);
      if (document)
        this.entries[path] = strToU8(serializer.serializeToString(document));
    }
    return this.changed.size > 0;
  }
}
