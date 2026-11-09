import type { EpubImageResizer } from '@wordconvert/epub-writer';
import { imageSize } from 'image-size';
import { loadCanvas } from './native-runtime.ts';

export function inspectRasterImage(data: Uint8Array, mediaType: string) {
  if (data.length > 64 * 1024 * 1024)
    throw new Error('Raster image exceeds the 64 MiB image limit.');
  const info = imageSize(data);
  const expectedType =
    mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1];
  if (info.type !== expectedType)
    throw new Error('Raster image signature does not match its media type.');
  if (!info.width || !info.height || info.width * info.height > 40_000_000)
    throw new Error('Raster image exceeds the 40 megapixel decode limit.');
  let animated =
    mediaType === 'image/webp' &&
    Buffer.from(data.subarray(12, 16)).toString() === 'VP8X' &&
    !!(data[20]! & 2);
  if (mediaType === 'image/png') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 8; offset + 12 <= data.length;) {
      if (
        Buffer.from(data.subarray(offset + 4, offset + 8)).toString() === 'acTL'
      ) {
        animated = true;
        break;
      }
      offset += 12 + view.getUint32(offset);
    }
  }
  return { ...info, animated };
}

/** Creates a canvas-based resizer, or undefined when the native binding is unavailable. */
export function createImageResizer(
  runtimeDir?: string,
): EpubImageResizer | undefined {
  let canvasModule: ReturnType<typeof loadCanvas>;
  try {
    canvasModule = loadCanvas(runtimeDir);
  } catch {
    return undefined;
  }
  return async (data, mediaType, maxDimension, encoding) => {
    if (inspectRasterImage(data, mediaType).animated) return undefined;
    const image = await canvasModule.loadImage(Buffer.from(data));
    const scale = Math.min(
      1,
      maxDimension / Math.max(image.width, image.height),
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    let outputType = mediaType;
    if (encoding.format === 'jpeg') {
      const pixels = context.getImageData(0, 0, width, height).data;
      let transparent = false;
      for (let i = 3; i < pixels.length; i += 4)
        if (pixels[i] !== 255) {
          transparent = true;
          break;
        }
      outputType = transparent ? 'image/png' : 'image/jpeg';
    }
    const buffer =
      outputType === 'image/png'
        ? canvas.toBuffer('image/png')
        : outputType === 'image/webp'
          ? canvas.toBuffer('image/webp', encoding.quality)
          : canvas.toBuffer('image/jpeg', encoding.quality);
    return { data: new Uint8Array(buffer), mediaType: outputType };
  };
}
