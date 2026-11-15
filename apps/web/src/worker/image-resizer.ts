import type { EpubImageResizer } from '@wordconvert/epub-writer';

/** Resizes and encodes raster images; returns undefined when canvas is unavailable. */
export const resizeRasterImage: EpubImageResizer = async (
  data,
  mediaType,
  maxDimension,
  encoding,
  maxDimensions,
) => {
  if (
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  )
    return undefined;
  const bitmap = await createImageBitmap(
    new Blob([data as BlobPart], { type: mediaType }),
  );
  try {
    const scale = Math.min(
      1,
      maxDimension > 0
        ? maxDimension / Math.max(bitmap.width, bitmap.height)
        : 1,
      maxDimensions ? maxDimensions.width / bitmap.width : 1,
      maxDimensions ? maxDimensions.height / bitmap.height : 1,
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
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
    const blob = await canvas.convertToBlob({
      type: outputType,
      ...(outputType === 'image/png'
        ? {}
        : { quality: encoding.quality / 100 }),
    });
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      mediaType: blob.type,
    };
  } finally {
    bitmap.close();
  }
};
