import type { EpubImageResizer } from '@wordconvert/epub-writer';
import { loadCanvas } from './native-runtime.ts';

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
  return async (data, mediaType, maxDimension) => {
    const image = await canvasModule.loadImage(Buffer.from(data));
    const scale = maxDimension / Math.max(image.width, image.height);
    if (scale >= 1) return undefined;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const buffer =
      mediaType === 'image/png'
        ? canvas.toBuffer('image/png')
        : mediaType === 'image/webp'
          ? canvas.toBuffer('image/webp', 85)
          : canvas.toBuffer('image/jpeg', 85);
    return new Uint8Array(buffer);
  };
}
