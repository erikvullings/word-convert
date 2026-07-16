import type { CoverRasterizer } from '@wordconvert/cover-generator';

/** Browser-only compatibility adapter for reading systems that require PNG covers. */
export class BrowserPngCoverRasterizer implements CoverRasterizer {
  async rasterize(
    svg: string,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    const source = URL.createObjectURL(
      new Blob([svg], { type: 'image/svg+xml' }),
    );
    try {
      const image = new Image();
      image.decoding = 'sync';
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error('PNG rasterization failed.')),
          'image/png',
        ),
      );
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      URL.revokeObjectURL(source);
    }
  }
}
