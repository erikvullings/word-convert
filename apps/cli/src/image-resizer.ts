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
  return async (data, mediaType, maxDimension, encoding) => {
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
