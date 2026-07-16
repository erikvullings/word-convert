import { strFromU8, unzipSync } from 'fflate';

import { fail } from './error.ts';

export interface ReaderLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
  maxImageBytes: number;
}

export interface DocxPackage {
  entries: Record<string, Uint8Array>;
  activeContentDisabled: boolean;
  xml(name: string): Uint8Array | undefined;
}

const isActiveAutomationPart = (name: string): boolean =>
  /^word\/(?:_rels\/)?vba(?:project|data)/i.test(name) ||
  /^word\/activex\//i.test(name) ||
  /^customui\//i.test(name);

const view16 = (bytes: Uint8Array, offset: number) =>
  bytes[offset]! | (bytes[offset + 1]! << 8);
const view32 = (bytes: Uint8Array, offset: number) =>
  (view16(bytes, offset) | (view16(bytes, offset + 2) << 16)) >>> 0;

function inspect(bytes: Uint8Array, limits: ReaderLimits): void {
  if (bytes.length > limits.maxCompressedBytes)
    fail('resource-limit', 'DOCX exceeds the compressed-size limit.', {
      limit: limits.maxCompressedBytes,
    });
  let eocd = -1;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65_557);
    index -= 1
  ) {
    if (view32(bytes, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail('invalid-input', 'Input is not a complete ZIP package.');
  const count = view16(bytes, eocd + 10);
  if (count > limits.maxEntries)
    fail('resource-limit', 'DOCX exceeds the ZIP entry limit.', {
      limit: limits.maxEntries,
      actual: count,
    });
  const centralSize = view32(bytes, eocd + 12);
  let cursor = view32(bytes, eocd + 16);
  if (cursor + centralSize > eocd)
    fail('invalid-input', 'ZIP central directory is malformed.');
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (view32(bytes, cursor) !== 0x02014b50)
      fail('invalid-input', 'ZIP central directory is malformed.');
    const flags = view16(bytes, cursor + 8);
    const compressed = view32(bytes, cursor + 20);
    const uncompressed = view32(bytes, cursor + 24);
    const nameLength = view16(bytes, cursor + 28);
    const extraLength = view16(bytes, cursor + 30);
    const commentLength = view16(bytes, cursor + 32);
    const name = strFromU8(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if ((flags & 1) !== 0)
      fail('encrypted-document', 'Encrypted DOCX packages are not supported.');
    if (
      name.startsWith('/') ||
      name.startsWith('\\') ||
      name.split(/[\\/]/).includes('..')
    )
      fail('invalid-input', 'ZIP entry path traversal is not allowed.');
    expanded += uncompressed;
    if (expanded > limits.maxUncompressedBytes)
      fail('resource-limit', 'DOCX exceeds the expanded-size limit.', {
        limit: limits.maxUncompressedBytes,
      });
    if (
      uncompressed > 0 &&
      (compressed === 0 ||
        uncompressed / compressed > limits.maxCompressionRatio)
    )
      fail(
        'resource-limit',
        'DOCX ZIP entry exceeds the compression-ratio limit.',
        { limit: limits.maxCompressionRatio },
      );
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

export function openDocxPackage(
  bytes: Uint8Array,
  limits: ReaderLimits,
): DocxPackage {
  if (bytes.length < 4 || view32(bytes, 0) !== 0x04034b50)
    fail('unsupported-format', 'Input is not a DOCX ZIP package.');
  inspect(bytes, limits);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return fail('invalid-input', 'DOCX ZIP package is malformed.');
  }
  if (entries['EncryptedPackage'] || entries['EncryptionInfo'])
    fail('encrypted-document', 'Encrypted Word documents are not supported.');
  let activeContentDisabled = false;
  for (const name of Object.keys(entries)) {
    if (!isActiveAutomationPart(name)) continue;
    delete entries[name];
    activeContentDisabled = true;
  }
  return {
    entries,
    activeContentDisabled,
    xml: (name) => entries[name],
  };
}
