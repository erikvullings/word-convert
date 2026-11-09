import { describe, expect, it } from 'vitest';
import { loadCanvas } from './native-runtime.ts';
import { createImageResizer } from './image-resizer.ts';

const canvasModule = loadCanvas();

function raster(width: number, height: number, transparent = false) {
  const canvas = canvasModule.createCanvas(width, height);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(width, height);
  let seed = 42;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed >>> 24) % 32;
    pixels.data[i] = (((i / 4) % width) / width) * 220 + noise;
    pixels.data[i + 1] = (Math.floor(i / 4 / width) / height) * 220 + noise;
    pixels.data[i + 2] = 100 + noise;
    pixels.data[i + 3] = transparent && i === 0 ? 0 : 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}

describe('EPUB image encoding', () => {
  it('compresses opaque PNGs below the dimension limit without upscaling', async () => {
    const source = raster(800, 600);
    const result = await createImageResizer()!(source, 'image/png', 1600, {
      format: 'jpeg',
      quality: 80,
    });
    expect(result).toHaveProperty('mediaType', 'image/jpeg');
    if (!result || result instanceof Uint8Array)
      throw new Error('Expected typed encoding.');
    expect(result.data.byteLength).toBeLessThan(source.byteLength);
    const image = await canvasModule.loadImage(Buffer.from(result.data));
    expect([image.width, image.height]).toEqual([800, 600]);
  });

  it.each([
    ['jpeg', true],
    ['preserve', false],
  ] as const)(
    'preserves PNG with %s policy and transparency=%s',
    async (format, transparent) => {
      const result = await createImageResizer()!(
        raster(400, 200, transparent),
        'image/png',
        200,
        {
          format,
          quality: 80,
        },
      );
      if (!result || result instanceof Uint8Array)
        throw new Error('Expected typed encoding.');
      expect(result.mediaType).toBe('image/png');
      const image = await canvasModule.loadImage(Buffer.from(result.data));
      expect([image.width, image.height]).toEqual([200, 100]);
    },
  );

  it('honors JPEG quality on already-small images', async () => {
    const resize = createImageResizer()!;
    const source = raster(600, 400);
    const low = await resize(source, 'image/png', 1600, {
      format: 'jpeg',
      quality: 30,
    });
    const high = await resize(source, 'image/png', 1600, {
      format: 'jpeg',
      quality: 95,
    });
    if (
      !low ||
      low instanceof Uint8Array ||
      !high ||
      high instanceof Uint8Array
    )
      throw new Error('Expected typed encoding.');
    expect(low.data.byteLength).toBeLessThan(high.data.byteLength);
  });
});
