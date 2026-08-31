import type { PdfFigureRasterizer } from '@wordconvert/pdf-reader';

export function createPdfFigureRasterizer(): PdfFigureRasterizer | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  return {
    CanvasFactory: WorkerCanvasFactory,
    FilterFactory: WorkerFilterFactory,
    createSurface(width, height) {
      const canvas = new OffscreenCanvas(width, height);
      return {
        canvas,
        readRgba() {
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas rendering is unavailable.');
          return context.getImageData(0, 0, width, height).data;
        },
        async encodePng() {
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          return new Uint8Array(await blob.arrayBuffer());
        },
        dispose() {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}

class WorkerCanvasFactory {
  create(
    width: number,
    height: number,
  ): {
    canvas: OffscreenCanvas;
    context: OffscreenCanvasRenderingContext2D;
  } {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    return { canvas, context };
  }

  reset(
    target: { canvas: OffscreenCanvas },
    width: number,
    height: number,
  ): void {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }): void {
    if (target.canvas) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
    target.canvas = null;
    target.context = null;
  }
}

class WorkerFilterFactory {
  addFilter(): string {
    return 'none';
  }

  addHCMFilter(): string {
    return 'none';
  }

  addAlphaFilter(): string {
    return 'none';
  }

  addLuminosityFilter(): string {
    return 'none';
  }

  addKnockoutFilter(): string {
    return 'none';
  }

  addHighlightHCMFilter(): string {
    return 'none';
  }

  addSelectionHCMFilter(): string {
    return 'none';
  }

  addSelectionFilter(): string {
    return 'none';
  }

  createSelectionStyle(): null {
    return null;
  }

  destroy(): void {}
}
