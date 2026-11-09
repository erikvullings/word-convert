import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFile,
  link,
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
const directories: string[] = [];
const fixedDate = ['--conversion-date', '2026-01-02'];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'wordconvert-cli-test-'));
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

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('CLI arguments and output', () => {
  it('defaults to EPUB even when streaming output', async () => {
    const result = await invoke([fixture, '-o', '-', ...fixedDate]);
    expect(result.code).toBe(0);
    const output = result.output[0];
    expect(output).toBeInstanceOf(Uint8Array);
    if (output instanceof Uint8Array)
      expect(new TextDecoder().decode(unzipSync(output).mimetype)).toBe(
        'application/epub+zip',
      );
  });

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
    expect((await invoke(['--version'])).output[0]).toBe(`${version}\n`);
  });

  it.each([
    [],
    [fixture, fixture],
    [fixture, '--format', 'pdf'],
    [fixture, '--formula-mode', 'unsafe'],
    [fixture, '--max-image-size', '-5'],
    [fixture, '--max-image-size', '800', '--format', 'html'],
    [fixture, '--image-format', 'webp'],
    [fixture, '--image-format', 'jpeg', '--format', 'html'],
    [fixture, '--image-quality', '0'],
    [fixture, '--image-quality', '101'],
    [fixture, '--image-quality', '80.5'],
    [fixture, '--image-quality', 'NaN'],
    [fixture, '--image-quality', '80', '--format', 'markdown'],
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
    expect(result.errors).toContain('cli-pdf-geometry-only');
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
