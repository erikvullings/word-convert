import { describe, expect, it } from 'vitest';

import { resolveTexTellerDevModelDirectory } from './vite.config.ts';
import { textTellerAssetPath } from './src/worker/texteller-assets.ts';
import {
  pdfJsDecoderAssetPath,
  pdfJsDecoderAssets,
  pdfJsDecoderBaseUrl,
  pdfJsWorkerAssetPath,
  pdfJsWorkerUrl,
} from './src/pdfjs-assets.ts';

describe('Vite formula recognizer configuration', () => {
  it('uses the same relative asset directory in development and builds', () => {
    expect(textTellerAssetPath('tokenizer.json')).toBe(
      'texteller/tokenizer.json',
    );
  });

  it('uses an explicit model directory before the local development cache', () => {
    expect(
      resolveTexTellerDevModelDirectory('/models/texteller', () => false),
    ).toBe('/models/texteller');
  });

  it('discovers the local development cache only when it exists', () => {
    const checked: string[] = [];
    expect(
      resolveTexTellerDevModelDirectory(undefined, (path) => {
        checked.push(path);
        return path === '/tmp/texteller-q4';
      }),
    ).toBe('/tmp/texteller-q4');
    expect(checked.at(-1)).toBe('/tmp/texteller-q4');
    expect(
      resolveTexTellerDevModelDirectory(undefined, () => false),
    ).toBeUndefined();
  });
});

describe('PDF.js decoder assets', () => {
  it('keeps decoder URLs within the configured application base path', () => {
    expect(
      pdfJsDecoderBaseUrl(
        '/word-convert/',
        'https://example.test/document-selection',
      ),
    ).toBe('https://example.test/word-convert/pdfjs/');
  });

  it('keeps the PDF worker on a stable application-owned URL', () => {
    expect(
      pdfJsWorkerUrl(
        '/word-convert/',
        'https://example.test/document-selection',
      ),
    ).toBe('https://example.test/word-convert/pdfjs/pdf.worker.mjs');
    expect(pdfJsWorkerAssetPath).toBe('pdfjs/pdf.worker.mjs');
  });

  it('bundles the image decoders and their license files', () => {
    expect(pdfJsDecoderAssets).toEqual(
      expect.arrayContaining([
        'jbig2.wasm',
        'openjpeg.wasm',
        'qcms_bg.wasm',
        'LICENSE_JBIG2',
        'LICENSE_OPENJPEG',
        'LICENSE_QCMS',
      ]),
    );
    expect(pdfJsDecoderAssetPath('openjpeg.wasm')).toBe('pdfjs/openjpeg.wasm');
  });
});
