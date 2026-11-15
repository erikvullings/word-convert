import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineDebugDump } from './pipeline-debug.ts';

const directories: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'wordconvert-pipeline-test-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('pipeline stage dumps', () => {
  it('hashes binary assets and bounds long raw text collections', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, 'source');
    const dumpDirectory = join(root, 'dump');
    await mkdir(sourceDirectory);
    const input = join(sourceDirectory, 'book.pdf');
    await writeFile(input, 'PDF');
    const dump = await createPipelineDebugDump({
      directory: dumpDirectory,
      input,
      output: '-',
      cwd: root,
      force: false,
      includeAssets: false,
      request: { input: 'book.pdf' },
      warn: () => {},
    });
    expect(dump).toBeDefined();
    dump!.onStage({
      stage: 'raw',
      data: {
        version: 1,
        pageCount: 1,
        metadata: {},
        outline: [],
        pages: [
          {
            number: 1,
            width: 1,
            height: 1,
            rotation: 0,
            spans: Array.from({ length: 9000 }, (_, index) => ({
              id: `span-${index}`,
              text: 'x'.repeat(2000),
              x: 0,
              top: 0,
              width: 1,
              height: 1,
              fontId: 'font',
              fontSize: 12,
              bold: false,
              italic: false,
              direction: 'ltr',
            })),
            links: [],
            images: [
              {
                id: 'image-1',
                x: 0,
                top: 0,
                width: 1,
                height: 1,
                pixelWidth: 1,
                pixelHeight: 1,
                mediaType: 'image/png',
                data: new Uint8Array([0, 1, 2]),
              },
            ],
          },
        ],
      },
    });

    const raw = JSON.parse(
      await readFile(join(dumpDirectory, '1-raw.json'), 'utf8'),
    );
    expect(raw.truncated).toBe(true);
    expect(raw.pages[0].spans.length).toBeLessThan(9000);
    expect(raw.pages[0].images[0].data).toEqual({
      size: 3,
      sha256:
        'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc',
    });
    expect(
      (await readFile(join(dumpDirectory, '1-raw.json'))).byteLength,
    ).toBeLessThan(16 * 1024 * 1024);
  });

  it('writes writer text artifacts verbatim and records binary assets by hash', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, 'source');
    const dumpDirectory = join(root, 'dump');
    await mkdir(sourceDirectory);
    const input = join(sourceDirectory, 'book.docx');
    await writeFile(input, 'DOCX');
    const dump = await createPipelineDebugDump({
      directory: dumpDirectory,
      input,
      output: '-',
      cwd: root,
      force: false,
      includeAssets: false,
      request: {},
      warn: () => {},
    });
    const xhtml = '<html><body>sample</body></html>';
    dump!.onStage({
      stage: 'output',
      data: {
        'EPUB/nav.xhtml': Buffer.from(xhtml),
        'EPUB/images/cover.png': new Uint8Array([1, 2, 3]),
        'EPUB/readme.txt': new Uint8Array([0xff, 0x00]),
      },
    });

    expect(
      await readFile(join(dumpDirectory, '4-output/EPUB/nav.xhtml'), 'utf8'),
    ).toBe(xhtml);
    const assets = JSON.parse(
      await readFile(join(dumpDirectory, '4-output/assets.json'), 'utf8'),
    );
    expect(assets.assets[0]).toEqual({
      path: 'EPUB/images/cover.png',
      size: 3,
      sha256:
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      included: false,
    });
    expect(assets.assets[1]).toMatchObject({
      path: 'EPUB/readme.txt',
      size: 2,
      included: false,
    });
    expect(assets.assets[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readFile(join(dumpDirectory, '4-output/EPUB/readme.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts embedded data-URI assets and degrades dump writes to warnings', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, 'source');
    const dumpDirectory = join(root, 'dump');
    await mkdir(sourceDirectory);
    const input = join(sourceDirectory, 'book.html');
    await writeFile(input, 'HTML');
    const warnings: string[] = [];
    const dump = await createPipelineDebugDump({
      directory: dumpDirectory,
      input,
      output: '-',
      cwd: root,
      force: false,
      includeAssets: false,
      request: {},
      warn: (message) => warnings.push(message),
    });
    dump!.onStage({
      stage: 'output',
      data: {
        'document.html': Buffer.from(
          '<img src="data:image/png;base64,AAECAw==">',
        ),
      },
    });
    const html = await readFile(
      join(dumpDirectory, '4-output/document.html'),
      'utf8',
    );
    expect(html).not.toContain('AAECAw==');
    expect(html).toContain('wordconvert-asset-ref:inline-asset-001');
    const inlineAsset = JSON.parse(
      await readFile(join(dumpDirectory, '4-output/assets.json'), 'utf8'),
    ).assets[0];
    expect(inlineAsset).toMatchObject({
      path: 'document.html#inline-asset-001',
      size: 4,
    });
    expect(inlineAsset.sha256).toMatch(/^[a-f0-9]{64}$/);

    await rm(dumpDirectory, { recursive: true });
    await writeFile(dumpDirectory, 'replaced');
    expect(() =>
      dump!.onStage({
        stage: 'model',
        data: {},
      }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it('preserves exact writer artifacts when asset inclusion is enabled', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, 'source');
    const dumpDirectory = join(root, 'dump');
    await mkdir(sourceDirectory);
    const input = join(sourceDirectory, 'book.html');
    await writeFile(input, 'HTML');
    const dump = await createPipelineDebugDump({
      directory: dumpDirectory,
      input,
      output: '-',
      cwd: root,
      force: false,
      includeAssets: true,
      request: {},
      warn: () => {},
    });
    const html = Buffer.from('<img src="data:image/png;base64,AAECAw==">');
    const image = new Uint8Array([0, 1, 2, 3]);
    dump!.onStage({
      stage: 'output',
      data: {
        'document.html': html,
        'images/cover.png': image,
      },
    });

    expect(
      await readFile(join(dumpDirectory, '4-output/document.html')),
    ).toEqual(html);
    expect(
      await readFile(join(dumpDirectory, '4-output/images/cover.png')),
    ).toEqual(Buffer.from(image));
    const assets = JSON.parse(
      await readFile(join(dumpDirectory, '4-output/assets.json'), 'utf8'),
    );
    expect(assets.assets).toHaveLength(2);
    expect(assets.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'document.html#inline-asset-001',
          size: 4,
          included: true,
        }),
        expect.objectContaining({
          path: 'images/cover.png',
          size: 4,
          included: true,
        }),
      ]),
    );
  });
});
