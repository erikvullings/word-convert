import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32, rgbaToPng } from './png.ts';

function bitwiseCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe('crc32', () => {
  it('matches the standard CRC-32 check values', () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });

  it('matches the bitwise reference for every block remainder', () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = pseudoRandomBytes(length, length + 1);
      expect(crc32(bytes)).toBe(bitwiseCrc32(bytes));
    }
    const large = pseudoRandomBytes(100_003, 7);
    expect(crc32(large)).toBe(bitwiseCrc32(large));
  });

  it('checksums several parts as one contiguous sequence', () => {
    const bytes = pseudoRandomBytes(1_001, 3);
    expect(
      crc32(bytes.subarray(0, 5), bytes.subarray(5, 517), bytes.subarray(517)),
    ).toBe(crc32(bytes));
  });
});

describe('rgbaToPng', () => {
  it('writes chunks with valid checksums and the original pixels', async () => {
    const width = 13;
    const height = 7;
    const rgba = pseudoRandomBytes(width * height * 4, 11);
    const png = await rgbaToPng(rgba, width, height);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const types: string[] = [];
    const idat: Uint8Array[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = view.getUint32(offset);
      const typeAndData = png.subarray(offset + 4, offset + 8 + length);
      const type = String.fromCharCode(...typeAndData.subarray(0, 4));
      types.push(type);
      expect(view.getUint32(offset + 8 + length)).toBe(
        bitwiseCrc32(typeAndData),
      );
      if (type === 'IDAT') idat.push(typeAndData.subarray(4));
      offset += 12 + length;
    }
    expect(types[0]).toBe('IHDR');
    expect(types.at(-1)).toBe('IEND');
    const compressed = new Uint8Array(
      idat.reduce((total, part) => total + part.length, 0),
    );
    let position = 0;
    for (const part of idat) {
      compressed.set(part, position);
      position += part.length;
    }
    const scanlines = unzlibSync(compressed);
    const rowBytes = width * 4;
    for (let row = 0; row < height; row++) {
      const start = row * (rowBytes + 1);
      expect(scanlines[start]).toBe(0);
      expect(scanlines.subarray(start + 1, start + 1 + rowBytes)).toEqual(
        rgba.subarray(row * rowBytes, (row + 1) * rowBytes),
      );
    }
  });
});
