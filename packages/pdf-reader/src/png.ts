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
    uint32(crc32(join([typeBytes, data]))),
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
