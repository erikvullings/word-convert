export const pdfJsDecoderAssets = [
  'jbig2.wasm',
  'jbig2_nowasm_fallback.js',
  'openjpeg.wasm',
  'openjpeg_nowasm_fallback.js',
  'qcms_bg.wasm',
  'LICENSE_JBIG2',
  'LICENSE_OPENJPEG',
  'LICENSE_PDFJS_JBIG2',
  'LICENSE_PDFJS_OPENJPEG',
  'LICENSE_PDFJS_QCMS',
  'LICENSE_QCMS',
] as const;

export type PdfJsDecoderAsset = (typeof pdfJsDecoderAssets)[number];
export const pdfJsWorkerAssetPath = 'pdfjs/pdf.worker.mjs';

export function pdfJsDecoderAssetPath(file: PdfJsDecoderAsset): string {
  return `pdfjs/${file}`;
}

export function pdfJsDecoderBaseUrl(basePath: string, origin: string): string {
  return new URL('pdfjs/', new URL(basePath, origin)).href;
}

export function pdfJsWorkerUrl(basePath: string, origin: string): string {
  return new URL(pdfJsWorkerAssetPath, new URL(basePath, origin)).href;
}
