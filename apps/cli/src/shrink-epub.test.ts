import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { imageSize } from 'image-size';
import { createImageResizer } from './image-resizer.ts';
import { loadCanvas } from './native-runtime.ts';
import { runCli } from './cli.ts';
import { shrinkEpub, type ShrinkEpubOptions } from './shrink-epub.ts';

const imagePath = 'Book/Images/art & chart.png';
const jpegPath = 'Book/Images/art & chart.jpg';
const opfPath = 'Book/content.opf';
const container =
  '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">test</dc:identifier><dc:title>Book title</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-02T00:00:00Z</meta></metadata>
<manifest><item id="image" href="Images/art%20%26%20chart.png" media-type="image/png" properties="cover-image"/>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="style" href="styles.css" media-type="text/css"/></manifest>
<spine><itemref idref="chapter"/></spine></package>`;
const chapter =
  '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Keep this exact content.</p><img src="Images/art%20%26%20chart.png" alt="Photo"/></body></html>';

function photo() {
  const canvas = loadCanvas().createCanvas(640, 480);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(640, 480);
  let seed = 42;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed >>> 24) % 40;
    pixels.data[i] = ((i / 4) % 640) / 3 + noise;
    pixels.data[i + 1] = Math.floor(i / 4 / 640) / 3 + noise;
    pixels.data[i + 2] = 100 + noise;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}
const originalPhoto = photo();

function fixture(extra: Zippable = {}) {
  return zipSync(
    {
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8(container),
      [opfPath]: strToU8(opf),
      [imagePath]: originalPhoto,
      'Book/chapter.xhtml': strToU8(chapter),
      'Book/nav.xhtml': strToU8(
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>',
      ),
      'Book/styles.css': strToU8(
        'p { color: black } body { background: url("Images/art%20%26%20chart.png") }',
      ),
      'Book/cover.svg': strToU8(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="Images/art%20%26%20chart.png"/></svg>',
      ),
      'Book/font.otf': new Uint8Array([0, 1, 2, 3]),
      ...extra,
    },
    { mtime: new Date('1980-01-01T00:00:00Z') },
  );
}
function options(): ShrinkEpubOptions {
  return {
    maxDimension: 1600,
    format: 'jpeg',
    quality: 80,
    resize: createImageResizer()!,
    warn: vi.fn(),
  };
}
const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'wordconvert-shrink-test-'));
  directories.push(dir);
  return dir;
}
async function invoke(args: string[]) {
  const output: (string | Uint8Array)[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    stdout: async (data) => {
      output.push(data);
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
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('EPUB image optimization without book reconstruction', () => {
  it('shrinks images and updates filenames and references while preserving book content', async () => {
    const input = fixture();
    const result = await shrinkEpub(input, options());
    expect(result.length).toBeLessThan(input.length / 2);
    const before = unzipSync(input),
      after = unzipSync(result);
    expect(Object.keys(after).length).toBe(Object.keys(before).length);
    expect(after[imagePath]).toBeUndefined();
    expect(after['Book/font.otf']).toEqual(before['Book/font.otf']);
    expect(after['Book/nav.xhtml']).toEqual(before['Book/nav.xhtml']);
    for (const path of [
      'Book/chapter.xhtml',
      'Book/styles.css',
      'Book/cover.svg',
    ])
      expect(strFromU8(after[path]!)).toContain('Images/art%20%26%20chart.jpg');
    expect(strFromU8(after['Book/chapter.xhtml']!)).toContain(
      'Keep this exact content.',
    );
    expect(imageSize(after[jpegPath]!)).toMatchObject({
      type: 'jpg',
      width: 640,
      height: 480,
    });
    expect(strFromU8(after[opfPath]!)).toContain('media-type="image/jpeg"');
    expect(strFromU8(after[opfPath]!)).toContain('properties="cover-image"');
    expect(strFromU8(after[opfPath]!)).toContain('2026-01-02T00:00:00Z');
    expect(
      new DataView(result.buffer, result.byteOffset).getUint16(8, true),
    ).toBe(0);
    expect(Object.keys(after)[0]).toBe('mimetype');
    expect(await shrinkEpub(input, options())).toEqual(result);
  });

  it('honors dimensions and quality overrides', async () => {
    const input = fixture();
    const low = await shrinkEpub(input, {
      ...options(),
      maxDimension: 320,
      quality: 30,
    });
    const high = await shrinkEpub(input, {
      ...options(),
      maxDimension: 320,
      quality: 95,
    });
    expect(imageSize(unzipSync(low)[jpegPath]!)).toMatchObject({
      width: 320,
      height: 240,
    });
    expect(low.length).toBeLessThan(high.length);
  });

  it('updates all rendition manifests referring to the same image', async () => {
    const input = fixture({
      'META-INF/container.xml': strToU8(
        container.replace(
          '</rootfiles>',
          '<rootfile full-path="Book/alternate.opf"/></rootfiles>',
        ),
      ),
      'Book/alternate.opf': strToU8(opf),
    });
    const output = unzipSync(await shrinkEpub(input, options()));
    for (const path of [opfPath, 'Book/alternate.opf'])
      expect(strFromU8(output[path]!)).toContain('media-type="image/jpeg"');
  });

  it('returns the original bytes with optimization disabled or when no encoding saves bytes', async () => {
    const input = fixture();
    expect(
      await shrinkEpub(input, {
        ...options(),
        maxDimension: 0,
        resize: async () => {
          throw new Error('Must not run');
        },
      }),
    ).toBe(input);
    expect(
      await shrinkEpub(input, { ...options(), resize: async (data) => data }),
    ).toBe(input);
  });

  it('keeps animated images and non-raster resources unchanged', async () => {
    const input = fixture({
      [opfPath]: strToU8(
        opf.replace('media-type="image/png"', 'media-type="image/gif"'),
      ),
      [imagePath]: new Uint8Array([71, 73, 70, 56, 57, 97]),
    });
    expect(await shrinkEpub(input, options())).toBe(input);
  });

  it('reports codec failure and retains the original rather than dropping the image', async () => {
    const input = fixture(),
      settings = options();
    expect(
      await shrinkEpub(input, {
        ...settings,
        resize: async () => {
          throw new Error('Codec failed');
        },
      }),
    ).toBe(input);
    expect(settings.warn).toHaveBeenCalledWith(
      expect.stringContaining('original retained'),
    );
  });

  it.each(['META-INF/encryption.xml', 'META-INF/signatures.xml'])(
    'rejects protected packages: %s',
    async (path) => {
      await expect(
        shrinkEpub(fixture({ [path]: strToU8('<protected/>') }), options()),
      ).rejects.toThrow('cannot be shrunk');
    },
  );

  it.each(['../escape', '/absolute', 'folder\\escape'])(
    'rejects unsafe ZIP paths: %s',
    async (path) => {
      const extra: Zippable = Object.create(null);
      extra[path] = strToU8('unsafe');
      await expect(shrinkEpub(fixture(extra), options())).rejects.toThrow(
        'unsafe',
      );
    },
  );

  it('rejects duplicate paths, ZIP64, and oversized declared entries before decompression', async () => {
    const input = fixture();
    const central = new DataView(input.buffer, input.byteOffset).getUint32(
      input.length - 6,
      true,
    );
    const huge = input.slice();
    new DataView(huge.buffer).setUint32(central + 24, 65 * 1024 * 1024, true);
    await expect(shrinkEpub(huge, options())).rejects.toThrow(
      'expansion limits',
    );
    const zip64 = input.slice();
    new DataView(zip64.buffer).setUint16(zip64.length - 12, 65535, true);
    await expect(shrinkEpub(zip64, options())).rejects.toThrow('ZIP64');
    const duplicate = fixture({
      'Book/same1': strToU8('a'),
      'Book/same2': strToU8('b'),
    });
    const text = Buffer.from(duplicate);
    for (
      let offset = text.indexOf('Book/same2');
      offset !== -1;
      offset = text.indexOf('Book/same2', offset + 1)
    )
      text.write('Book/same1', offset);
    await expect(shrinkEpub(text, options())).rejects.toThrow('duplicate');
    const prototype = Buffer.from(fixture({ __pr0to__: strToU8('unsafe') }));
    for (
      let offset = prototype.indexOf('__pr0to__');
      offset !== -1;
      offset = prototype.indexOf('__pr0to__', offset + 1)
    )
      prototype.write('__proto__', offset);
    await expect(shrinkEpub(prototype, options())).rejects.toThrow('unsafe');
  });

  it('rejects DTDs, missing images, escaping manifest paths, and incorrect image signatures', async () => {
    for (const manifest of [
      '<!DOCTYPE package [<!ENTITY x "test">]>' + opf,
      opf.replace('Images/art%20%26%20chart.png', 'missing.png'),
      opf.replace('Images/art%20%26%20chart.png', '../../escape.png'),
    ])
      await expect(
        shrinkEpub(fixture({ [opfPath]: strToU8(manifest) }), options()),
      ).rejects.toThrow();
    await expect(
      shrinkEpub(fixture({ [imagePath]: strToU8('<svg/>') }), options()),
    ).rejects.toThrow();
  });

  it('rejects decompression bombs and oversized image pixel dimensions', async () => {
    await expect(
      shrinkEpub(fixture({ bomb: new Uint8Array(2 * 1024 * 1024) }), options()),
    ).rejects.toThrow('expansion limits');
    const largeImage = new Uint8Array(originalPhoto);
    new DataView(largeImage.buffer).setUint32(16, 100000);
    await expect(
      shrinkEpub(fixture({ [imagePath]: largeImage }), options()),
    ).rejects.toThrow('megapixel');
  });
});

describe('CLI EPUB input', () => {
  it('supports optional chapter splitting through the CLI', async () => {
    const dir = await directory(),
      path = join(dir, 'book.epub');
    await writeFile(
      path,
      fixture({
        'Book/chapter.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><h1>One</h1><p>First</p><h1>Two</h1><p>Second</p></body></html>',
        ),
      }),
    );
    const result = await invoke([
      path,
      '--split-chapters',
      '--max-image-size',
      '0',
      '-o',
      '-',
    ]);
    expect(result.code, result.errors).toBe(0);
    expect(Object.keys(unzipSync(result.output[0] as Uint8Array))).toContain(
      'Book/chapter-chapter-002.xhtml',
    );
  });

  it('defaults to a sibling .shrunk.epub without modifying the source', async () => {
    const dir = await directory(),
      source = fixture(),
      path = join(dir, 'book.epub');
    await writeFile(path, source);
    const result = await invoke([path, '--offline']);
    expect(result.code, result.errors).toBe(0);
    expect(result.errors).toContain('EPUB size:');
    expect((await readFile(join(dir, 'book.shrunk.epub'))).length).toBeLessThan(
      source.length,
    );
    expect(await readFile(path)).toEqual(Buffer.from(source));
    expect((await invoke([path])).code).toBe(1);
    expect((await invoke([path, '--force'])).code).toBe(0);
  });

  describe('EPUB navigation and optional chapter organization', () => {
    const chapters =
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Full book</title></head><body><section id="wrapper"><h1 id="one">Chapter One</h1><p>First chapter text. <a href="#two">Next</a></p><h1 id="two">Chapter Two</h1><p>Second chapter text. <a href="#one">Back</a><img src="Images/art%20%26%20chart.png" alt="Photo"/></p></section></body></html>';

    it('repairs a declared but missing navigation file and retains its spine ID', async () => {
      const entries = unzipSync(
        fixture({
          [opfPath]: strToU8(
            opf.replace('<spine>', '<spine><itemref idref="nav"/>'),
          ),
          'Book/chapter.xhtml': strToU8(chapters),
        }),
      );
      delete entries['Book/nav.xhtml'];
      const input = zipSync({
        ...entries,
        mimetype: [entries.mimetype!, { level: 0 }],
      });
      const result = unzipSync(
        await shrinkEpub(input, { ...options(), maxDimension: 0 }),
      );
      const manifest = strFromU8(result[opfPath]!);
      expect(manifest).toContain('id="nav" href="wordconvert-nav.xhtml"');
      expect(manifest).toContain('<itemref idref="nav"/>');
      expect(manifest).not.toContain('href="nav.xhtml"');
      expect(strFromU8(result['Book/wordconvert-nav.xhtml']!)).toContain(
        'Chapter Two',
      );
    });

    it('rejects unsafe resource relocation in scripted books but allows format-preserving optimization', async () => {
      const input = fixture({
        'Book/chapter.xhtml': strToU8(
          chapter.replace(
            '</body>',
            '<script>load("Images/art &amp; chart.png")</script></body>',
          ),
        ),
      });
      await expect(shrinkEpub(input, options())).rejects.toThrow(
        'scripted EPUB',
      );
      await expect(
        shrinkEpub(input, { ...options(), format: 'preserve' }),
      ).resolves.toBeDefined();
    });

    it('preserves existing replacement characters with an explicit warning', async () => {
      const settings = options();
      const input = fixture({
        'Book/chapter.xhtml': strToU8(
          chapter.replace('exact content', 'exact \uFFFD content'),
        ),
      });
      const result = unzipSync(await shrinkEpub(input, settings));
      expect(strFromU8(result['Book/chapter.xhtml']!)).toContain(
        'exact \uFFFD content',
      );
      expect(settings.warn).toHaveBeenCalledWith(
        expect.stringContaining('text is preserved'),
      );
    });

    it('generates a missing EPUB 3 TOC from headings without splitting by default', async () => {
      const result = unzipSync(
        await shrinkEpub(
          fixture({
            [opfPath]: strToU8(opf.replace(' properties="nav"', '')),
            'Book/chapter.xhtml': strToU8(chapters),
          }),
          { ...options(), maxDimension: 0 },
        ),
      );
      expect(result['Book/chapter-chapter-002.xhtml']).toBeUndefined();
      const toc = strFromU8(result['Book/wordconvert-nav.xhtml']!);
      expect(toc).toContain('chapter.xhtml#one');
      expect(toc).toContain('chapter.xhtml#two');
      expect(toc).toContain('Chapter Two');
      expect(strFromU8(result[opfPath]!)).toContain('properties="nav"');
    });

    it('adds collision-free heading anchors and falls back to spine documents when headings are absent', async () => {
      const input = fixture({
        [opfPath]: strToU8(opf.replace(' properties="nav"', '')),
        'Book/chapter.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><p id="wordconvert-heading-1">Intro</p><h1>A heading</h1></body></html>',
        ),
      });
      const result = unzipSync(
        await shrinkEpub(input, { ...options(), maxDimension: 0 }),
      );
      expect(strFromU8(result['Book/wordconvert-nav.xhtml']!)).toContain(
        '#wordconvert-heading-2',
      );
      const settings = { ...options(), maxDimension: 0 };
      const fallback = unzipSync(
        await shrinkEpub(
          fixture({ [opfPath]: strToU8(opf.replace(' properties="nav"', '')) }),
          settings,
        ),
      );
      expect(strFromU8(fallback['Book/wordconvert-nav.xhtml']!)).toContain(
        'href="chapter.xhtml"',
      );
      expect(settings.warn).toHaveBeenCalledWith(
        expect.stringContaining('no usable headings'),
      );
    });

    it('creates NCX and wires the spine for EPUB 2 without adding EPUB 3 properties', async () => {
      const input = fixture({
        [opfPath]: strToU8(
          opf
            .replace('version="3.0"', 'version="2.0"')
            .replace(' properties="nav"', '')
            .replace(' properties="cover-image"', ''),
        ),
        'Book/chapter.xhtml': strToU8(chapters),
      });
      const result = unzipSync(
        await shrinkEpub(input, { ...options(), maxDimension: 0 }),
      );
      expect(strFromU8(result['Book/wordconvert-toc.ncx']!)).toContain(
        'chapter.xhtml#two',
      );
      expect(strFromU8(result[opfPath]!)).toContain(
        'toc="wordconvert-navigation"',
      );
      expect(strFromU8(result[opfPath]!)).not.toContain('properties="nav"');
    });

    it('splits nested chapter headings, updates existing TOC and cross-chapter links, and preserves text', async () => {
      const input = fixture({
        'Book/chapter.xhtml': strToU8(chapters),
        'Book/nav.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#two">Custom chapter label</a></li></ol></nav></body></html>',
        ),
      });
      const result = unzipSync(
        await shrinkEpub(input, { ...options(), splitChapters: true }),
      );
      const first = strFromU8(result['Book/chapter.xhtml']!);
      const second = strFromU8(result['Book/chapter-chapter-002.xhtml']!);
      expect(first).toContain('First chapter text.');
      expect(first).not.toContain('Second chapter text.');
      expect(second).toContain('Second chapter text.');
      expect(second).not.toContain('First chapter text.');
      expect(first).toContain('href="chapter-chapter-002.xhtml#two"');
      expect(second).toContain('href="chapter.xhtml#one"');
      expect(second).toContain('Images/art%20%26%20chart.jpg');
      const toc = strFromU8(result['Book/nav.xhtml']!);
      expect(toc).toContain('chapter-chapter-002.xhtml#two');
      expect(toc).toContain('Custom chapter label');
      expect(strFromU8(result[opfPath]!)).toContain(
        'idref="chapter-chapter-2"',
      );
    });

    it('uses H2 chapter headings when H1 is only the book title', async () => {
      const input = fixture({
        'Book/chapter.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><h1>Book</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></body></html>',
        ),
      });
      const result = unzipSync(
        await shrinkEpub(input, {
          ...options(),
          maxDimension: 0,
          splitChapters: true,
        }),
      );
      expect(result['Book/chapter-chapter-002.xhtml']).toBeDefined();
      expect(result['Book/chapter-chapter-003.xhtml']).toBeDefined();
    });

    it('rewrites srcset, inline CSS, CSS escapes, fragments, and SVG xlink references without filename collisions', async () => {
      const input = fixture({
        'Book/Images/art & chart.jpg': strToU8('existing unrelated resource'),
        'Book/chapter.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title><style>body{background:url("Images/art%20%26%20chart.png")}</style></head><body style="background:url(Images/art%20%26%20chart.png)"><picture><source type="image/png" srcset="Images/art%20%26%20chart.png 1x, https://example.org/remote.png 2x"/><img src="Images/art%20%26%20chart.png#detail" alt="Figure"/></picture></body></html>',
        ),
        'Book/cover.svg': strToU8(
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="Images/art%20%26%20chart.png"/></svg>',
        ),
      });
      const result = unzipSync(await shrinkEpub(input, options()));
      expect(strFromU8(result['Book/chapter.xhtml']!)).toContain(
        'Images/art%20%26%20chart-1.jpg#detail',
      );
      expect(strFromU8(result['Book/chapter.xhtml']!)).toContain(
        'https://example.org/remote.png 2x',
      );
      expect(strFromU8(result['Book/cover.svg']!)).toContain(
        'Images/art%20%26%20chart-1.jpg',
      );
      expect(strFromU8(result['Book/Images/art & chart.jpg']!)).toBe(
        'existing unrelated resource',
      );
    });
  });

  it('streams output and rejects in-place and hard-linked overwrites even with --force', async () => {
    const dir = await directory(),
      path = join(dir, 'book.epub'),
      alias = join(dir, 'alias.epub');
    await writeFile(path, fixture());
    await link(path, alias);
    for (const output of [path, alias])
      expect((await invoke([path, '-o', output, '--force'])).code).toBe(2);
    const result = await invoke([path, '-o', '-']);
    expect(result.code, result.errors).toBe(0);
    expect(result.output[0]).toBeInstanceOf(Uint8Array);
  });

  it.each([
    ['-f', 'html'],
    ['--title', 'Changed'],
    ['--author', 'Changed'],
    ['--language', 'nl'],
    ['--formula-mode', 'mathml'],
    ['--conversion-date', '2026-01-01'],
    ['--include-external-images'],
    ['--no-layout'],
    ['--style-preset', 'preset.json'],
  ])('rejects unsupported EPUB options %j', async (...args) => {
    expect((await invoke(['book.epub', ...args])).code).toBe(2);
  });

  it('accepts EPUB archives above the normal 50 MiB source limit', async () => {
    const dir = await directory(),
      path = join(dir, 'large.epub');
    const source = fixture({
      'padding.bin': [new Uint8Array(51 * 1024 * 1024), { level: 0 }],
    });
    await writeFile(path, source);
    const result = await invoke([path, '--max-image-size', '0']);
    expect(result.code, result.errors).toBe(0);
    expect((await readFile(join(dir, 'large.shrunk.epub'))).length).toBe(
      source.length,
    );
  });
});
