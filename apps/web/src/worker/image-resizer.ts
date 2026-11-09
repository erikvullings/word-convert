import type { EpubImageResizer } from '@wordconvert/epub-writer';

/** Downscales raster images with OffscreenCanvas; returns undefined when unsupported or already small. */
export const resizeRasterImage: EpubImageResizer = async (
  data,
  mediaType,
  maxDimension,
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
    const scale = maxDimension / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return undefined;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({
      type: mediaType,
      ...(mediaType === 'image/png' ? {} : { quality: 0.85 }),
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
};
