import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { runCli } from './cli.ts';

vi.mock('./model-cache.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./model-cache.ts')>();
  return {
    ...original,
    ensureModel: async () => '/test/heron.onnx',
  };
});

vi.mock('./native-pdf.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./native-pdf.ts')>();
  return {
    ...original,
    createNativePdfAdapters: async (
      runtime: Parameters<typeof original.createNativePdfAdapters>[0],
      options: Parameters<typeof original.createNativePdfAdapters>[1],
    ) => {
      const adapters = await original.createNativePdfAdapters(runtime, {});
      if (!options.layoutModel) return adapters;
      return {
        ...adapters,
        layoutDetector: {
          inputSize: 64,
          detect: async () => [
            {
              label: 'table' as const,
              confidence: 0.93,
              x: 0.1,
              top: 0.25,
              width: 0.8,
              height: 0.45,
            },
          ],
        },
      };
    },
  };
});

it('keeps ruled tables in the CLI with default layout analysis enabled', async () => {
  const fixture = fileURLToPath(
    new URL('../../../tests/fixtures/pdf/ruled-table.pdf', import.meta.url),
  );
  const output: Array<string | Uint8Array> = [];
  const errors: string[] = [];

  const code = await runCli(
    [
      fixture,
      '--format',
      'html',
      '--output',
      '-',
      '--conversion-date',
      '2026-01-02',
    ],
    {
      stdout: async (value) => output.push(value),
      stderr: (message) => errors.push(message),
    },
  );

  expect(code, errors.join('')).toBe(0);
  expect(output[0]).toContain('<table');
  expect(output[0]).toContain('Revenue');
});

it('uses the scanned PDF front page as cover without repeating its image', async () => {
  const fixture = fileURLToPath(
    new URL('../../../tests/fixtures/pdf/scanned-page.pdf', import.meta.url),
  );
  const output: Array<string | Uint8Array> = [];
  const errors: string[] = [];

  const code = await runCli(
    [
      fixture,
      '--no-layout',
      '--frontpage-cover',
      '--output',
      '-',
      '--conversion-date',
      '2026-01-02',
    ],
    {
      stdout: async (value) => output.push(value),
      stderr: (message) => errors.push(message),
    },
  );

  expect(code, errors.join('')).toBe(0);
  const epub = output[0];
  if (!(epub instanceof Uint8Array)) throw new Error('Expected EPUB bytes.');
  const files = unzipSync(epub);
  expect(files['EPUB/cover.png']).toBeDefined();
  const coverPage = new TextDecoder().decode(files['EPUB/cover.xhtml']);
  const chapter = new TextDecoder().decode(files['EPUB/chapter-001.xhtml']);
  expect(coverPage).toContain('src="cover.png"');
  expect(chapter).not.toContain('<img');
});
