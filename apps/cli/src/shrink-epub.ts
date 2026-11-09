import { posix } from 'node:path';
import type { Element } from '@xmldom/xmldom';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { EpubImageResizer } from '@wordconvert/epub-writer';
import { inspectRasterImage } from './image-resizer.ts';
import {
  EpubStructure,
  localEpubPath,
  readEpubXml as parseXml,
} from './epub-structure.ts';

export const MAX_EPUB_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const OPF_NS = 'http://www.idpf.org/2007/opf';
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container';
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ZIP_TIME = new Date('1980-01-01T00:00:00Z');
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ShrinkEpubOptions {
  maxDimension: number;
  format: 'jpeg' | 'preserve';
  quality: number;
  splitChapters?: boolean;
  resize?: EpubImageResizer;
  warn(message: string): void;
}

function safePath(name: string): boolean {
  return (
    !!name &&
    name !== '__proto__' &&
    !/^[\\/]|[\\\p{Cc}]/u.test(name) &&
    !name.split('/').some((part) => part === '..' || part === '.') &&
    !/^[a-z]:/i.test(name)
  );
}

/** Validate central-directory sizes before fflate allocates expanded buffers. */
function inspectZip(bytes: Uint8Array): Map<string, number> {
  if (bytes.length > MAX_EPUB_INPUT_BYTES)
    throw new Error('EPUB exceeds the 256 MiB input limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 38 ||
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(8, true) !== 0 ||
    view.getUint16(26, true) !== 8 ||
    decoder.decode(bytes.subarray(30, 38)) !== 'mimetype'
  )
    throw new Error('EPUB must begin with a stored mimetype entry.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      if (i + 22 + view.getUint16(i + 20, true) !== bytes.length)
        throw new Error('EPUB ZIP end record is malformed.');
      end = i;
      break;
    }
  if (end < 0) throw new Error('EPUB is not a complete ZIP archive.');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    centralSize === 0xffffffff ||
    cursor === 0xffffffff
  )
    throw new Error('Split and ZIP64 EPUB archives are not supported.');
  if (count > MAX_ENTRIES)
    throw new Error('EPUB exceeds the 10000 ZIP entry limit.');
  if (cursor + centralSize !== end)
    throw new Error('EPUB ZIP central directory is malformed.');
  const sizes = new Map<string, number>();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error('EPUB ZIP central directory is malformed.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const next =
      cursor +
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    if (
      next > end ||
      offset + 30 > bytes.length ||
      view.getUint16(cursor + 34, true) ||
      compressed === 0xffffffff ||
      size === 0xffffffff
    )
      throw new Error('EPUB ZIP entry is malformed or uses ZIP64.');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    if (!safePath(name) || sizes.has(name))
      throw new Error('EPUB contains unsafe or duplicate ZIP paths.');
    if (flags & 1 || ![0, 8].includes(method))
      throw new Error('EPUB contains encrypted or unsupported ZIP entries.');
    if (((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000)
      throw new Error('EPUB ZIP symlinks are not supported.');
    expanded += size;
    if (
      size > MAX_ENTRY_BYTES ||
      expanded > MAX_EXPANDED_BYTES ||
      (size > 0 && (compressed === 0 || size / compressed > 1000))
    )
      throw new Error(
        'EPUB exceeds ZIP expansion limits (64 MiB/entry, 512 MiB total, ratio 1000).',
      );
    const localNameLength = view.getUint16(offset + 26, true);
    const dataStart =
      offset + 30 + localNameLength + view.getUint16(offset + 28, true);
    if (
      view.getUint32(offset, true) !== 0x04034b50 ||
      view.getUint16(offset + 6, true) !== flags ||
      view.getUint16(offset + 8, true) !== method ||
      decoder.decode(
        bytes.subarray(offset + 30, offset + 30 + localNameLength),
      ) !== name ||
      dataStart + compressed > view.getUint32(end + 16, true)
    )
      throw new Error('EPUB ZIP local header does not match its directory.');
    sizes.set(name, size);
    cursor = next;
  }
  if (cursor !== end) throw new Error('EPUB ZIP entry count is inconsistent.');
  return sizes;
}

export async function shrinkEpub(
  input: Uint8Array,
  options: ShrinkEpubOptions,
): Promise<Uint8Array> {
  const sizes = inspectZip(input);
  const entries: Record<string, Uint8Array> = unzipSync(input, {
    filter: (entry) => {
      if (sizes.get(entry.name) !== entry.originalSize)
        throw new Error('EPUB ZIP directory decoding is inconsistent.');
      return true;
    },
  });
  for (const [name, size] of sizes)
    if (entries[name]?.length !== size)
      throw new Error('EPUB expanded entry size differs from its ZIP header.');
  if (decoder.decode(entries.mimetype) !== 'application/epub+zip')
    throw new Error('Input is not an EPUB (missing or invalid mimetype).');
  if (
    Object.keys(entries).some((path) =>
      /^META-INF\/(?:encryption|signatures)\.xml$/i.test(path),
    )
  )
    throw new Error(
      'Encrypted, font-obfuscated, or signed EPUBs cannot be shrunk.',
    );
  const container = parseXml(
    entries['META-INF/container.xml'],
    'META-INF/container.xml',
    false,
    options.warn,
  );
  const rootfiles = Array.from(
    container.getElementsByTagNameNS(CONTAINER_NS, 'rootfile'),
  );
  if (!rootfiles.length)
    throw new Error('EPUB container has no package document.');
  const packages = new Map<string, ReturnType<typeof parseXml>>();
  const images = new Map<string, { type: string; items: Element[] }>();
  for (const rootfile of rootfiles) {
    const path = rootfile.getAttribute('full-path') ?? '';
    if (!safePath(path)) throw new Error('EPUB package path is unsafe.');
    if (packages.has(path)) continue;
    const document = parseXml(entries[path], path, false, options.warn);
    if (
      document.documentElement?.localName !== 'package' ||
      document.documentElement.namespaceURI !== OPF_NS
    )
      throw new Error('EPUB package document has an invalid root.');
    packages.set(path, document);
    for (const item of Array.from(
      document.getElementsByTagNameNS(OPF_NS, 'item'),
    )) {
      const type = item.getAttribute('media-type') ?? '';
      if (!RASTER_TYPES.has(type)) continue;
      const href = item.getAttribute('href') ?? '';
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
      const imagePath = localEpubPath(path, href);
      if (!entries[imagePath])
        throw new Error(`EPUB image is missing: ${imagePath}`);
      const existing = images.get(imagePath);
      if (existing && existing.type !== type)
        throw new Error('EPUB manifests disagree about an image media type.');
      if (existing) existing.items.push(item);
      else images.set(imagePath, { type, items: [item] });
    }
  }
  const structure = new EpubStructure(entries, packages, options.warn);
  if (options.splitChapters) structure.splitChapters();
  structure.addMissingToc();
  if (options.maxDimension > 0 && !options.resize && images.size)
    throw new Error(
      'EPUB shrinking requires the native canvas runtime. Keep runtime/ beside wordconvert.',
    );
  let changed = 0;
  let decodedPixels = 0;
  for (const [path, image] of images) {
    if (options.maxDimension === 0) break;
    const original = entries[path]!;
    // Validate encoded dimensions before asking the native decoder to allocate.
    const info = inspectRasterImage(original, image.type);
    if (info.animated) continue;
    decodedPixels += info.width * info.height;
    if (decodedPixels > 1_000_000_000)
      throw new Error(
        'EPUB exceeds the 1 gigapixel aggregate image decode limit.',
      );
    let result: Awaited<ReturnType<EpubImageResizer>>;
    try {
      result = await options.resize!(
        original,
        image.type,
        options.maxDimension,
        {
          format: options.format,
          quality: options.quality,
        },
      );
    } catch (error) {
      options.warn(
        `warning: Could not optimize EPUB image ${path}; original retained: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      continue;
    }
    if (!result) continue;
    const data = result instanceof Uint8Array ? result : result.data;
    const type = result instanceof Uint8Array ? image.type : result.mediaType;
    if (!RASTER_TYPES.has(type))
      throw new Error('Image optimizer returned an unsupported media type.');
    if (data.length >= original.length) continue;
    const extension =
      type === 'image/jpeg' ? '.jpg' : type === 'image/png' ? '.png' : '.webp';
    const originalExtension = posix.extname(path).toLowerCase();
    const destination =
      originalExtension === extension ||
      (type === 'image/jpeg' && originalExtension === '.jpeg')
        ? path
        : structure.uniquePath(
            path.slice(0, -posix.extname(path).length) + extension,
          );
    entries[destination] = data;
    structure.imageTypes.set(destination, type);
    if (destination !== path) {
      structure.moves.files.set(path, destination);
      delete entries[path];
    }
    changed++;
    if (type !== image.type) {
      for (const item of image.items) {
        item.setAttribute('media-type', type);
        for (const [packagePath, document] of packages)
          if (item.ownerDocument === document)
            structure.markPackage(packagePath);
      }
    }
  }
  const rewritten = structure.finish();
  if (!changed && !rewritten) return input;
  const files: Zippable = Object.create(null);
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  let expandedOutput = 0;
  if (Object.keys(entries).length > MAX_ENTRIES)
    throw new Error('Reorganized EPUB exceeds the 10000 ZIP entry limit.');
  for (const path of Object.keys(entries))
    if (path !== 'mimetype') {
      expandedOutput += entries[path]!.length;
      if (expandedOutput > MAX_EXPANDED_BYTES)
        throw new Error(
          'Reorganized EPUB exceeds the 512 MiB expanded-size limit.',
        );
      files[path] = entries[path]!;
    }
  const output = zipSync(files, { level: 9, mtime: ZIP_TIME });
  if (output.length >= input.length && !structure.hasStructuralChanges) {
    options.warn(
      'warning: Repacked EPUB was not smaller; original package retained.\n',
    );
    return input;
  }
  return output;
}
