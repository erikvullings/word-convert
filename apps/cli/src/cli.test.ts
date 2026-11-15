import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { runCli } from './cli.ts';
import { version } from '../package.json';

const fixture = fileURLToPath(
  new URL(
    '../../../tests/fixtures/docx/standard-comprehensive.docx',
    import.meta.url,
  ),
);
const pdf = fileURLToPath(
  new URL('../../../tests/fixtures/pdf/one-column-book.pdf', import.meta.url),
);
const existingPdfFixtures = [
  'one-column-book.pdf',
  'two-column-article.pdf',
  'tagged-article.pdf',
  'tagged-table.pdf',
  'tagged-table-spans.pdf',
  'scanned-page.pdf',
  'ruled-table.pdf',
  'borderless-table.pdf',
  'ruled-non-tables.pdf',
  'formula-layouts.pdf',
  'formula-false-positives.pdf',
].map((name) =>
  fileURLToPath(
    new URL(`../../../tests/fixtures/pdf/${name}`, import.meta.url),
  ),
);
const directories: string[] = [];
const fixedDate = ['--conversion-date', '2026-01-02'];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'wordconvert-cli-test-'));
  directories.push(path);
  return path;
}

async function workspaceDirectory() {
  const path = await mkdtemp(join(process.cwd(), '.wordconvert-cli-test-'));
  directories.push(path);
  return path;
}

async function invoke(args: string[]) {
  const output: Array<string | Uint8Array> = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    stdout: async (value) => {
      output.push(value);
    },
    stderr: (message) => {
      errors.push(message);
    },
  });
  return { code, output, errors: errors.join('') };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('CLI arguments and output', () => {
  // The first conversion cold-loads reader/writer and native codec modules.
  it('defaults to EPUB even when streaming output', async () => {
    const result = await invoke([fixture, '-o', '-', ...fixedDate]);
    expect(result.code).toBe(0);
    const output = result.output[0];
    expect(output).toBeInstanceOf(Uint8Array);
    if (output instanceof Uint8Array)
      expect(new TextDecoder().decode(unzipSync(output).mimetype)).toBe(
        'application/epub+zip',
      );
  }, 15_000);

  it.each([
    ['book.epub', 'epub'],
    ['book.html', 'html'],
    ['book.HTM', 'html'],
    ['book.md', 'markdown'],
    ['book.markdown', 'markdown'],
    ['book.html.zip', 'html-zip'],
    ['book.md.zip', 'markdown-zip'],
    ['book.markdown.zip', 'markdown-zip'],
    ['book.unknown', 'epub'],
  ])('infers %s as %s', async (filename, format) => {
    const output = join(await directory(), filename);
    const result = await invoke([fixture, '-o', output, ...fixedDate]);
    expect(result.code).toBe(0);
    const data = await readFile(output);
    if (format === 'html') expect(data.toString()).toMatch(/^<!doctype html>/);
    else if (format === 'markdown')
      expect(data.toString()).toContain('Fixture Corpus');
    else {
      const files = unzipSync(data);
      expect(
        files[
          format === 'epub'
            ? 'mimetype'
            : format === 'html-zip'
              ? 'document.html'
              : 'document.md'
        ],
      ).toBeDefined();
    }
  });

  it('lets explicit format override an extension, and rejects ambiguous ZIP inference', async () => {
    const output = join(await directory(), 'book.zip');
    expect((await invoke([fixture, '-o', output])).code).toBe(2);
    expect((await invoke([fixture, '-f', 'html', '-o', output])).code).toBe(0);
    expect(await readFile(output, 'utf8')).toMatch(/^<!doctype html>/);
  });

  it('prints help/version without loading conversion or native runtimes', async () => {
    expect((await invoke(['--help'])).output[0]).toContain(
      'Usage: wordconvert',
    );
    expect((await invoke(['--help'])).output[0]).toContain('--unwrap-factor');
    expect((await invoke(['--help'])).output[0]).toContain('--dehyphenate');
    expect((await invoke(['--help'])).output[0]).toContain('--debug-pipeline');
    expect((await invoke(['--help'])).output[0]).toContain(
      '--debug-pipeline-assets',
    );
    expect((await invoke(['--help'])).output[0]).toContain('--verbose');
    expect((await invoke(['--help'])).output[0]).toContain(
      'Pipeline dumps contain document text',
    );
    expect((await invoke(['--version'])).output[0]).toBe(`${version}\n`);
  });

  it('dumps the same PDF stages and preserves output bytes', async () => {
    const debug = join(await directory(), 'pdf-dump');
    const args = [
      pdf,
      '--no-layout',
      '--offline',
      '-f',
      'epub',
      '-o',
      '-',
      ...fixedDate,
    ];
    const baseline = await invoke(args);
    const result = await invoke([
      ...args,
      '--debug-pipeline',
      debug,
      '--force',
    ]);

    expect(result.code, result.errors).toBe(0);
    expect(result.output).toEqual(baseline.output);
    expect(result.errors).toContain('Stage raw:');
    expect(result.errors).toContain('Stage analysis:');
    expect(result.errors).toContain('Stage model:');
    expect(result.errors).toContain('Stage output:');
    const request = await readJson(join(debug, '0-request.json'));
    const raw = await readJson(join(debug, '1-raw.json'));
    const analysis = await readJson(join(debug, '2-analysis.json'));
    const model = await readJson(join(debug, '3-model.json'));
    const packageFile = await readFile(
      join(debug, '4-output/EPUB/package.opf'),
      'utf8',
    );
    expect(request.schema).toBe(1);
    expect(request.stage).toBe('request');
    expect(JSON.stringify(request)).not.toContain(process.cwd());
    expect(raw.pageCount).toBeGreaterThan(0);
    expect(Array.isArray(raw.pages)).toBe(true);
    expect(analysis.crop).toBeDefined();
    expect(Array.isArray(analysis.candidates)).toBe(true);
    expect(Array.isArray(model.blocks)).toBe(true);
    expect(packageFile).toContain('<package');
    const repeatedDebug = join(await directory(), 'pdf-dump-repeat');
    const repeated = await invoke([
      ...args,
      '--debug-pipeline',
      repeatedDebug,
      '--force',
    ]);
    expect(repeated.code, repeated.errors).toBe(0);
    for (const stageFile of [
      '0-request.json',
      '1-raw.json',
      '2-analysis.json',
      '3-model.json',
      '4-output/EPUB/package.opf',
    ])
      expect(await readFile(join(repeatedDebug, stageFile))).toEqual(
        await readFile(join(debug, stageFile)),
      );
  }, 30_000);

  it('dumps the DOCX semantic model and records unavailable reader stages', async () => {
    const debug = join(await directory(), 'docx-dump');
    const args = [fixture, '-f', 'html', '-o', '-', ...fixedDate];
    const baseline = await invoke(args);
    const result = await invoke([
      ...args,
      '--debug-pipeline',
      debug,
      '--force',
    ]);

    expect(result.code, result.errors).toBe(0);
    expect(result.output).toEqual(baseline.output);
    expect((await readJson(join(debug, '1-raw.json'))).status).toBe(
      'not-applicable',
    );
    expect((await readJson(join(debug, '2-analysis.json'))).status).toBe(
      'not-applicable',
    );
    expect((await readJson(join(debug, '3-model.json'))).blocks).toBeDefined();
    const dumpedHtml = await readFile(
      join(debug, '4-output/document.html'),
      'utf8',
    );
    expect(dumpedHtml).not.toContain('base64,');
    expect(
      dumpedHtml.match(/wordconvert-asset-ref:inline-asset-\d+/g),
    ).toHaveLength(2);
    expect(
      (await readJson(join(debug, '4-output/assets.json'))).assets,
    ).toHaveLength(2);
    const exactDebug = join(await directory(), 'docx-exact-dump');
    const exact = await invoke([
      ...args,
      '--debug-pipeline',
      exactDebug,
      '--debug-pipeline-assets',
      '--force',
    ]);
    expect(exact.code, exact.errors).toBe(0);
    expect(exact.output).toEqual(baseline.output);
    const baselineHtml = baseline.output[0];
    if (baselineHtml === undefined) throw new Error('Expected HTML output.');
    expect(await readFile(join(exactDebug, '4-output/document.html'))).toEqual(
      Buffer.from(baselineHtml),
    );
    const exactAssets = (
      await readJson(join(exactDebug, '4-output/assets.json'))
    ).assets as Array<{ included: boolean }>;
    expect(exactAssets).toHaveLength(2);
    expect(exactAssets.every((asset) => asset.included)).toBe(true);
    const verbose = await invoke([...args, '--verbose', '--verbose']);
    expect(verbose.code).toBe(0);
    expect(verbose.output).toEqual(baseline.output);
    expect(verbose.errors).toContain('Stage model:');
    expect(verbose.errors).toContain('Options: format=html');
    expect(verbose.errors).toContain('Models: provider=not-used');
  }, 30_000);

  it('dumps EPUB-shrink artifacts without changing the repacked bytes', async () => {
    const sourcePath = join(await directory(), 'source.epub');
    const created = await invoke([
      fixture,
      '--max-image-size',
      '0',
      '-f',
      'epub',
      '-o',
      '-',
      ...fixedDate,
    ]);
    expect(created.code, created.errors).toBe(0);
    const source = created.output[0];
    if (!(source instanceof Uint8Array))
      throw new Error('Expected generated EPUB bytes.');
    await writeFile(sourcePath, source);
    const args = [sourcePath, '--max-image-size', '0', '-o', '-'];
    const baseline = await invoke(args);
    const debug = join(await directory(), 'epub-dump');
    const result = await invoke([
      ...args,
      '--debug-pipeline',
      debug,
      '--force',
    ]);

    expect(result.code, result.errors).toBe(0);
    expect(result.output).toEqual(baseline.output);
    expect((await readJson(join(debug, '1-raw.json'))).status).toBe(
      'not-applicable',
    );
    expect((await readJson(join(debug, '3-model.json'))).status).toBe(
      'not-applicable',
    );
    expect(
      await readFile(join(debug, '4-output/EPUB/nav.xhtml'), 'utf8'),
    ).toContain('<nav');
  }, 30_000);

  it('bounds verbose levels and enforces pipeline dump path boundaries', async () => {
    expect((await invoke([fixture, '--debug-pipeline-assets'])).code).toBe(2);
    expect(
      (await invoke([fixture, '--verbose', '--verbose', '--verbose'])).code,
    ).toBe(2);
    const outside = join(await directory(), 'outside-dump');
    expect(
      (
        await invoke([
          fixture,
          '-f',
          'html',
          '-o',
          '-',
          '--debug-pipeline',
          outside,
        ])
      ).code,
    ).toBe(2);

    const outputDump = join(await directory(), 'dump-with-output');
    expect(
      (
        await invoke([
          fixture,
          '-f',
          'html',
          '-o',
          join(outputDump, 'document.html'),
          '--debug-pipeline',
          outputDump,
        ])
      ).code,
    ).toBe(2);

    const parent = await workspaceDirectory();
    const inputDirectory = join(parent, 'source');
    await mkdir(inputDirectory);
    const input = join(inputDirectory, 'document.docx');
    await copyFile(fixture, input);
    expect(
      (
        await invoke([
          input,
          '-f',
          'html',
          '-o',
          '-',
          '--debug-pipeline',
          parent,
          '--force',
        ])
      ).code,
    ).toBe(2);

    const existing = join(await directory(), 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'private');
    expect(
      (
        await invoke([
          fixture,
          '-f',
          'html',
          '-o',
          '-',
          '--debug-pipeline',
          existing,
          '--force',
        ])
      ).code,
    ).toBe(2);
  });

  it.each([
    [],
    [fixture, fixture],
    [fixture, '--format', 'pdf'],
    [fixture, '--formula-mode', 'unsafe'],
    [fixture, '--max-image-size', '-5'],
    [fixture, '--split-chapters'],
    [fixture, '--max-image-size', '800', '--format', 'html'],
    [fixture, '--image-format', 'webp'],
    [fixture, '--image-format', 'jpeg', '--format', 'html'],
    [fixture, '--image-quality', '0'],
    [fixture, '--image-quality', '101'],
    [fixture, '--image-quality', '80.5'],
    [fixture, '--image-quality', 'NaN'],
    [fixture, '--image-quality', '80', '--format', 'markdown'],
    [fixture, '--cover', 'cover.png', '--format', 'html'],
    [fixture, '--frontpage-cover'],
    [pdf, '--frontpage-cover', '--format', 'html'],
    [pdf, '--cover', 'cover.png', '--frontpage-cover'],
    [fixture, '--conversion-date', '2026-02-30'],
    [fixture, '--conversion-date', '2026-01-01T24:00:00Z'],
    [fixture, '--language', 'not a language'],
    [fixture, '--title', ' '],
    [fixture, '--unknown'],
    [fixture, '--output'],
    ['file.docm'],
    ['https://example.org/file.docx'],
    [fixture, '--layout-model', 'model.onnx'],
    [pdf, '--execution-provider', 'invalid'],
    [pdf, '--execution-provider', 'webgpu', '--no-layout'],
    [pdf, '--layout-model', 'model.onnx', '--no-layout'],
    [fixture, '--formula-ocr'],
    [pdf, '--clear-model-cache'],
    [fixture, '--execution-provider', 'coreml', '--layout-model', 'model.onnx'],
    [pdf, '--execution-provider', ''],
    [pdf, '--pdf-tables', 'nonsense'],
    [pdf, '--pdf-tables', 'none,ruled'],
    [pdf, '--pdf-tables', ''],
    [fixture, '--pdf-tables', 'none'],
    [pdf, '--unwrap-factor', '1.1'],
    [pdf, '--unwrap-factor', 'NaN'],
    [pdf, '--dehyphenate', 'sometimes'],
    [fixture, '--dehyphenate', 'on'],
    [fixture, '--unwrap-factor', '0.5'],
  ])('rejects invalid arguments %j', async (...args) => {
    const result = await invoke(args);
    expect(result.code).toBe(2);
    expect(result.output).toEqual([]);
    expect(result.errors).toContain('wordconvert:');
  });

  it.each(['html', 'markdown', 'html-zip', 'markdown-zip', 'epub'])(
    'writes deterministic %s output with separate warnings',
    async (format) => {
      const args = [fixture, '-f', format, '-o', '-', ...fixedDate];
      const first = await invoke(args);
      const second = await invoke(args);
      expect(first.code).toBe(0);
      expect(first.output).toEqual(second.output);
      expect(first.output).toHaveLength(1);
      expect(first.errors).toContain('[');
      const data = first.output[0]!;
      if (typeof data === 'string') {
        expect(data).toContain('Fixture Corpus');
        expect(data).not.toContain('Written');
        if (format === 'html') expect(data).toMatch(/^<!doctype html>/);
      } else {
        const files = unzipSync(data);
        if (format === 'epub') {
          expect(new TextDecoder().decode(files.mimetype)).toBe(
            'application/epub+zip',
          );
          expect(new TextDecoder().decode(files['EPUB/package.opf'])).toContain(
            '2026-01-02T00:00:00Z',
          );
        } else
          expect(
            files[format === 'html-zip' ? 'document.html' : 'document.md'],
          ).toBeDefined();
      }
    },
  );

  it('converts a PDF through the core reader without models', async () => {
    const result = await invoke([
      pdf,
      '--no-layout',
      '-f',
      'markdown',
      '-o',
      '-',
      ...fixedDate,
    ]);
    expect(result.code).toBe(0);
    expect(result.output[0]).toContain('A Practical Book');
    expect(result.output[0]).not.toMatch(/Page \d+ of 6/);
    expect(result.errors).toContain('pdf-repeated-page-furniture');
    expect(result.errors).toContain('cli-pdf-geometry-only');
  });

  it('accepts PDF reflow options without enabling model downloads', async () => {
    const result = await invoke([
      pdf,
      '--no-layout',
      '--unwrap-factor',
      '0.4',
      '--dehyphenate',
      'on',
      '-f',
      'markdown',
      '-o',
      '-',
      ...fixedDate,
    ]);

    expect(result.code).toBe(0);
    expect(result.errors).toContain('pdf-dehyphenation-summary');
    expect(result.output[0]).toContain('A Practical Book');
  });

  it('keeps existing PDF corpus output byte-identical by default', async () => {
    for (const input of existingPdfFixtures) {
      const base = [
        input,
        '--no-layout',
        '-f',
        'markdown',
        '-o',
        '-',
        ...fixedDate,
      ];
      const defaultOutput = await invoke(base);
      const geometryOutput = await invoke([...base, '--unwrap-factor', '0']);

      expect(defaultOutput.code).toBe(0);
      expect(geometryOutput.code).toBe(0);
      expect(defaultOutput.output, input).toEqual(geometryOutput.output);
    }
  });

  it('defaults missing PDF language to English for EPUB without an override', async () => {
    const result = await invoke([
      pdf,
      '--no-layout',
      '-f',
      'epub',
      '-o',
      '-',
      ...fixedDate,
    ]);
    expect(result.code).toBe(0);
    const output = result.output[0];
    expect(output).toBeInstanceOf(Uint8Array);
    if (output instanceof Uint8Array) {
      const files = unzipSync(output);
      expect(new TextDecoder().decode(files['EPUB/package.opf'])).toContain(
        '<dc:language>en</dc:language>',
      );
    }
  });

  it('reports a missing default model in offline mode without starting a download', async () => {
    const result = await invoke([
      pdf,
      '--offline',
      '--model-cache-dir',
      await directory(),
      '-o',
      '-',
    ]);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('Model is not cached');
    expect(result.errors).not.toContain('Downloading');
  });

  it('clears only managed cache files without requiring a document', async () => {
    const cache = await directory();
    await writeFile(join(cache, 'heron.onnx'), 'old model');
    await writeFile(join(cache, 'my-model.onnx'), 'custom');
    const result = await invoke([
      '--clear-model-cache',
      '--model-cache-dir',
      cache,
    ]);
    expect(result.code).toBe(0);
    expect(result.errors).toContain('Removed 1');
    expect(await readFile(join(cache, 'my-model.onnx'), 'utf8')).toBe('custom');
  });

  it('applies metadata overrides and SPA-compatible style presets', async () => {
    const preset = join(await directory(), 'preset.json');
    await writeFile(
      preset,
      JSON.stringify({
        schema: 'wordconvert.style-preset',
        version: 1,
        mappings: { Heading1: 'ignore' },
      }),
    );
    const result = await invoke([
      fixture,
      '-o',
      '-',
      '-f',
      'html',
      '--style-preset',
      preset,
      '--title',
      'Custom title',
      '--author',
      'Alice',
      '--author',
      'Bob',
      '--language',
      'nl-NL',
      '--identifier',
      'urn:test:cli',
      ...fixedDate,
    ]);
    expect(result.code).toBe(0);
    expect(result.output[0]).toContain('<title>Custom title</title>');
    expect(result.output[0]).toContain('lang="nl-NL"');
    expect(result.output[0]).toContain('Alice');
    expect(result.output[0]).toContain('Bob');
    expect(result.output[0]).not.toContain('Standard heading');
  });

  it('embeds a supplied image as the EPUB cover', async () => {
    const cover = join(await directory(), 'cover.png');
    await writeFile(
      cover,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const result = await invoke([
      fixture,
      '--cover',
      cover,
      '-o',
      '-',
      ...fixedDate,
    ]);

    expect(result.code, result.errors).toBe(0);
    const output = result.output[0];
    if (!(output instanceof Uint8Array))
      throw new Error('Expected EPUB bytes.');
    const files = unzipSync(output);
    const opf = new TextDecoder().decode(files['EPUB/package.opf']);
    const coverSvg = new TextDecoder().decode(files['EPUB/cover.svg']);
    expect(opf).toContain(
      'href="cover.svg" media-type="image/svg+xml" properties="cover-image"',
    );
    expect(files['EPUB/cover.xhtml']).toBeDefined();
    expect(coverSvg).toContain('data:image/png;base64,');
  });

  it.each([
    '{"schema":"wordconvert.style-preset","version":2,"mappings":{}}',
    '{"schema":"wordconvert.style-preset","version":1,"mappings":{"x":"script"}}',
    '{"schema":"wordconvert.style-preset","version":1,"mappings":{"__proto__":"body"}}',
    'invalid JSON',
  ])('rejects invalid presets %s', async (json) => {
    const preset = join(await directory(), 'preset.json');
    await writeFile(preset, json);
    expect((await invoke([fixture, '--style-preset', preset])).code).toBe(2);
  });

  it('does not overwrite files without --force, and leaves no temporary files', async () => {
    const path = await directory();
    const input = join(path, 'source.docx');
    const output = join(path, 'source.epub');
    await copyFile(fixture, input);
    expect((await invoke([input, ...fixedDate])).code).toBe(0);
    const first = await readFile(output);
    expect((await invoke([input, '--title', 'Replacement'])).code).toBe(1);
    expect(await readFile(output)).toEqual(first);
    expect(
      (await invoke([input, '--title', 'Replacement', '--force'])).code,
    ).toBe(0);
    const files = unzipSync(await readFile(output));
    expect(new TextDecoder().decode(files['EPUB/package.opf'])).toContain(
      'Replacement',
    );
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(path)).sort()).toEqual([
      'source.docx',
      'source.epub',
    ]);
  });

  it('protects source and hard-link aliases even with --force', async () => {
    const path = await directory();
    const input = join(path, 'source.docx');
    const alias = join(path, 'alias.html');
    await copyFile(fixture, input);
    await link(input, alias);
    for (const output of [input, alias])
      expect((await invoke([input, '-o', output, '--force'])).code).toBe(2);
    expect(await readFile(input)).toEqual(await readFile(fixture));
  });

  it('rejects oversized and malformed input without leaving output', async () => {
    const path = await directory();
    const input = join(path, 'large.docx');
    const { open } = await import('node:fs/promises');
    const handle = await open(input, 'w');
    await handle.truncate(50 * 1024 * 1024 + 1);
    await handle.close();
    expect((await invoke([input])).code).toBe(1);
    await expect(stat(join(path, 'large.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await writeFile(input, 'not a DOCX');
    expect((await invoke([input])).code).toBe(1);
  });
});

describe('CLI PDF table signals', () => {
  const path = (name: string) =>
    fileURLToPath(
      new URL(`../../../tests/fixtures/pdf/${name}`, import.meta.url),
    );
  // Avoid model downloads here; layout precedence has a separate CLI regression.
  const html = async (args: string[]) => {
    const result = await invoke([
      ...args,
      '--no-layout',
      '-f',
      'html',
      '-o',
      '-',
      ...fixedDate,
    ]);
    expect(result.code).toBe(0);
    return String(result.output[0]);
  };

  it('turns ruled table detection off on request', async () => {
    expect(await html([path('ruled-table.pdf')])).toContain('<table');
    const output = await html([
      path('ruled-table.pdf'),
      '--pdf-tables',
      'none',
    ]);
    expect(output).not.toContain('<table');
    // Turning the signal off must not lose the cells either.
    expect(output).toContain('Revenue');
    expect(output).toContain('120');
  }, 30_000);

  it('enables borderless tables on request', async () => {
    expect(await html([path('borderless-table.pdf')])).not.toContain('<table');
    const output = await html([
      path('borderless-table.pdf'),
      '--pdf-tables',
      'tagged,ruled,borderless',
    ]);
    expect(output).toContain('<table');
    expect(output).toContain('Region');
    expect(output).toContain('44%');
    // The heading and the list below the grid stay paragraphs.
    expect(output).toContain('Distribution by region');
    expect(output).toContain('figures are unaudited');
  }, 30_000);

  it('keeps only the tagged signal when the others are dropped', async () => {
    const tagged = path('tagged-table.pdf');
    expect(await html([tagged, '--pdf-tables', 'ruled'])).not.toContain(
      '<table',
    );
    expect(await html([tagged, '--pdf-tables', 'tagged'])).toContain('<table');
  }, 30_000);
});
