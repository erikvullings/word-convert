import { afterEach, describe, expect, it, vi } from 'vitest';
import { resizeRasterImage } from './image-resizer.ts';

afterEach(() => vi.unstubAllGlobals());

describe('EPUB browser image encoding', () => {
  it.each([false, true])(
    'encodes small images with transparency=%s',
    async (transparent) => {
      const close = vi.fn();
      vi.stubGlobal('createImageBitmap', async () => ({
        width: 800,
        height: 600,
        close,
      }));
      const convert = vi.fn(
        async ({ type }: { type: string }) =>
          new Blob([new Uint8Array(10)], { type }),
      );
      const draw = vi.fn();
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor(width: number, height: number) {
            expect([width, height]).toEqual([800, 600]);
          }
          getContext() {
            return {
              drawImage: draw,
              getImageData: () => ({
                data: new Uint8ClampedArray([
                  10,
                  20,
                  30,
                  transparent ? 128 : 255,
                ]),
              }),
            };
          }
          convertToBlob = convert;
        },
      );
      const result = await resizeRasterImage(
        new Uint8Array(100),
        'image/png',
        1600,
        {
          format: 'jpeg',
          quality: 80,
        },
      );
      const type = transparent ? 'image/png' : 'image/jpeg';
      expect(result).toHaveProperty('mediaType', type);
      expect(convert).toHaveBeenCalledWith(
        transparent ? { type } : { type, quality: 0.8 },
      );
      expect(draw).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('releases the bitmap when encoding fails', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 800,
      height: 600,
      close,
    }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {} };
        }
        async convertToBlob() {
          throw new Error('Encoding failed');
        }
      },
    );
    await expect(
      resizeRasterImage(new Uint8Array(100), 'image/png', 1600, {
        format: 'preserve',
        quality: 80,
      }),
    ).rejects.toThrow('Encoding failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
