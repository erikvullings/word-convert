import { expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { runCli } from './cli.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

it.each(['md', 'markdown', 'html', 'htm', 'xhtml'])(
  'converts local %s to EPUB with local images and no native runtime',
  async (extension) => {
    const directory = await mkdtemp(join(tmpdir(), 'wordconvert-text-test-'));
    try {
      const input = join(directory, `book.${extension}`);
      const output = join(directory, 'book.epub');
      await mkdir(join(directory, 'images'));
      await writeFile(join(directory, 'images/diagram.png'), png);
      await writeFile(
        input,
        ['md', 'markdown'].includes(extension)
          ? '# Text book\n\nA **bold** paragraph.\n\n![Diagram](images/diagram.png)\n'
          : '<html lang="en"><head><title>Text book</title></head><body><h1>Chapter</h1><p>A <b>bold</b> paragraph.</p><img src="images/diagram.png" alt="Diagram"></body></html>',
      );
      const errors: string[] = [];
      const code = await runCli([input, '--conversion-date', '2026-01-02'], {
        stdout: async () => {
          throw new Error('Unexpected stdout');
        },
        stderr: (message) => errors.push(message),
      });
      expect(code, errors.join('')).toBe(0);
      const files = unzipSync(await readFile(output));
      expect(new TextDecoder().decode(files.mimetype)).toBe(
        'application/epub+zip',
      );
      expect(
        Object.keys(files).some((path) => /images\/.*\.png$/.test(path)),
      ).toBe(true);
      expect(
        Object.values(files)
          .map((bytes) => new TextDecoder().decode(bytes))
          .join('\n'),
      ).toContain('<strong>bold</strong>');
      expect(errors.join('')).not.toContain('Downloading');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('does not embed images outside the input directory, including symlink escapes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wordconvert-image-boundary-'));
  try {
    const root = join(parent, 'input');
    await mkdir(root);
    await writeFile(join(parent, 'outside.png'), png);
    await symlink(join(parent, 'outside.png'), join(root, 'escape.png'));
    const input = join(root, 'book.html');
    await writeFile(
      input,
      '<h1>Book</h1><img src="../outside.png" alt="Parent"><img src="escape.png" alt="Symlink"><img src="https://example.com/image.png" alt="Remote">',
    );
    const chunks: Uint8Array[] = [];
    const warnings: string[] = [];
    expect(
      await runCli([input, '-o', '-'], {
        stdout: async (value) => {
          if (value instanceof Uint8Array) chunks.push(value);
        },
        stderr: (message) => warnings.push(message),
      }),
    ).toBe(0);
    const files = unzipSync(chunks[0]!);
    expect(Object.keys(files).some((path) => path.includes('/images/'))).toBe(
      false,
    );
    expect(warnings.join('')).toContain('text-image-omitted');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it('protects included images from output overwrite even with force', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wordconvert-image-output-'));
  try {
    const input = join(directory, 'book.md');
    const image = join(directory, 'image.png');
    await writeFile(image, png);
    await writeFile(input, '# Book\n\n![Image](image.png)');
    const errors: string[] = [];
    expect(
      await runCli([input, '-o', image, '-f', 'epub', '--force'], {
        stdout: async () => undefined,
        stderr: (message) => errors.push(message),
      }),
    ).toBe(2);
    expect(await readFile(image)).toEqual(png);
    expect(errors.join('')).toContain('must not replace');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects malformed local raster images instead of embedding executable content', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'wordconvert-image-signature-'),
  );
  try {
    const input = join(directory, 'book.html');
    await writeFile(join(directory, 'image.png'), '<script>active</script>');
    await writeFile(input, '<h1>Book</h1><img src="image.png">');
    expect(
      await runCli([input, '-o', '-'], {
        stdout: async () => {
          throw new Error('Unexpected output');
        },
        stderr: () => undefined,
      }),
    ).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
