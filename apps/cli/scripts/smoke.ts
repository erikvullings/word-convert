import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const executable = resolve(process.argv[2] ?? '');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'wordconvert-smoke-'));
try {
  const command = join(
    temporary,
    process.platform === 'win32' ? 'wordconvert.exe' : 'wordconvert',
  );
  if (process.platform !== 'win32') await symlink(executable, command);
  const help = spawnSync(executable, ['--help'], {
    cwd: temporary,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: wordconvert/);
  for (const extension of ['md', 'html']) {
    const input = join(temporary, `text-source.${extension}`);
    const output = join(temporary, `text-source-${extension}.epub`);
    await writeFile(
      input,
      extension === 'md'
        ? '# Text book\n\nA **bold** paragraph.\n'
        : '<html lang="en"><head><title>Text book</title></head><body><h1>Chapter</h1><p>A <strong>bold</strong> paragraph.</p></body></html>',
    );
    const converted = spawnSync(executable, [input, '-o', output], {
      cwd: temporary,
      encoding: 'utf8',
    });
    assert.equal(converted.status, 0, converted.stderr);
    assert.ok((await readFile(output)).byteLength > 0);
    assert.doesNotMatch(
      converted.stderr,
      /Downloading|native runtime|Inference provider/,
    );
  }
  for (const format of [
    'html',
    'html-zip',
    'markdown',
    'markdown-zip',
    'epub',
  ]) {
    const output = join(temporary, format);
    const result = spawnSync(
      process.platform === 'win32' ? executable : command,
      [
        join(root, 'tests/fixtures/docx/standard-comprehensive.docx'),
        '--format',
        format,
        '--output',
        output,
        '--conversion-date',
        '2026-01-02',
      ],
      { cwd: temporary, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok((await readFile(output)).byteLength > 0);
  }
  const pdf = spawnSync(
    process.platform === 'win32' ? executable : command,
    [
      join(root, 'tests/fixtures/pdf/tagged-article.pdf'),
      '--rasterize',
      '--no-layout',
      '--format',
      'html',
      '--output',
      '-',
    ],
    { cwd: temporary, encoding: 'utf8' },
  );
  assert.equal(pdf.status, 0, pdf.stderr);
  assert.match(pdf.stdout, /^<!doctype html>/);
  assert.doesNotMatch(
    pdf.stdout + pdf.stderr,
    /Cannot load "@napi-rs\/canvas"/,
  );
  const missingRuntime = spawnSync(
    process.platform === 'win32' ? executable : command,
    [
      join(root, 'tests/fixtures/pdf/tagged-article.pdf'),
      '--no-layout',
      '--rasterize',
      '--runtime-dir',
      join(temporary, 'missing-runtime'),
      '--output',
      '-',
    ],
    { cwd: temporary, encoding: 'utf8' },
  );
  assert.equal(missingRuntime.status, 1);
  assert.match(missingRuntime.stderr, /Could not load native runtime/);
  const layoutModel = process.env.WORDCONVERT_CLI_HERON_MODEL;
  const formulaModelDir = process.env.WORDCONVERT_TEXTELLER_MODEL_DIR;
  const provider = process.env.WORDCONVERT_CLI_EXECUTION_PROVIDER ?? 'cpu';
  if (layoutModel || formulaModelDir) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = spawnSync(
        executable,
        [
          join(root, 'tests/fixtures/pdf/formula-layouts.pdf'),
          '--execution-provider',
          provider,
          ...(layoutModel
            ? ['--layout-model', resolve(layoutModel)]
            : ['--no-layout']),
          ...(formulaModelDir
            ? ['--formula-model-dir', resolve(formulaModelDir)]
            : []),
          '--format',
          'markdown',
          '--output',
          '-',
        ],
        { cwd: temporary, encoding: 'utf8', timeout: 180_000 },
      );
      assert.ifError(result.error);
      assert.equal(
        result.signal,
        null,
        `Native ${provider} terminated by ${result.signal}: ${result.stderr}`,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^# /);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /Cannot load "@napi-rs\/canvas"/,
      );
    }
  }
  console.log('Compiled CLI smoke checks passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
