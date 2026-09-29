import { Zlib } from 'fflate';

const COMPRESSION_CHUNK_BYTES = 1024 * 1024;

export async function rgbaToPng(
  rgba: Uint8Array,
  width: number,
  height: number,
  checkpoint: () => void | Promise<void> = () => undefined,
): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4)
    throw new RangeError('RGBA image data has an unexpected length.');
  const compressed: Uint8Array[] = [];
  const zlib = new Zlib(
    { level: 6 },
    (data) => data.length > 0 && compressed.push(Uint8Array.from(data)),
  );
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    zlib.push(Uint8Array.of(0));
    const rowStart = row * rowBytes;
    for (let offset = 0; offset < rowBytes; offset += COMPRESSION_CHUNK_BYTES) {
      const final =
        row === height - 1 && offset + COMPRESSION_CHUNK_BYTES >= rowBytes;
      zlib.push(
        rgba.subarray(
          rowStart + offset,
          rowStart + Math.min(offset + COMPRESSION_CHUNK_BYTES, rowBytes),
        ),
        final,
      );
      await checkpoint();
    }
  }
  const chunks = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk(
      'IHDR',
      join([uint32(width), uint32(height), Uint8Array.from([8, 6, 0, 0, 0])]),
    ),
    ...compressed.map((data) => chunk('IDAT', data)),
    chunk('IEND', new Uint8Array()),
  ];
  return joinAsync(chunks, checkpoint);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(
    [...type].map((character) => character.charCodeAt(0)),
  );
  return join([
    uint32(data.length),
    typeBytes,
    data,
    uint32(crc32(typeBytes, data)),
  ]);
}

function uint32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function joinAsync(
  parts: readonly Uint8Array[],
  checkpoint: () => void | Promise<void>,
): Promise<Uint8Array> {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
    await checkpoint();
  }
  return output;
}

// Slice-by-8 tables: CRC_TABLES[k][n] is the CRC of byte n followed by k zero bytes.
const CRC_TABLES = crcTables();

function crcTables(): Int32Array[] {
  const tables = Array.from({ length: 8 }, () => new Int32Array(256));
  const [first] = tables as [Int32Array];
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    first[n] = crc;
  }
  for (let n = 0; n < 256; n++)
    for (let k = 1; k < 8; k++) {
      const previous = tables[k - 1]![n]!;
      tables[k]![n] = (previous >>> 8) ^ first[previous & 0xff]!;
    }
  return tables;
}

export function crc32(...parts: readonly Uint8Array[]): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES as [
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
  ];
  let crc = -1;
  for (const bytes of parts) {
    let index = 0;
    const blocks = bytes.length - (bytes.length % 8);
    while (index < blocks) {
      const low =
        crc ^
        (bytes[index]! |
          (bytes[index + 1]! << 8) |
          (bytes[index + 2]! << 16) |
          (bytes[index + 3]! << 24));
      crc =
        t7[low & 0xff]! ^
        t6[(low >>> 8) & 0xff]! ^
        t5[(low >>> 16) & 0xff]! ^
        t4[low >>> 24]! ^
        t3[bytes[index + 4]!]! ^
        t2[bytes[index + 5]!]! ^
        t1[bytes[index + 6]!]! ^
        t0[bytes[index + 7]!]!;
      index += 8;
    }
    while (index < bytes.length)
      crc = (crc >>> 8) ^ t0[(crc ^ bytes[index++]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}
