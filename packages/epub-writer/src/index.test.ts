import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';
import { strFromU8, unzipSync } from 'fflate';
import type { CoverComposition } from '@wordconvert/cover-generator';
import { writeEpub } from './index.ts';

const epubcheckAvailable = spawnSync('epubcheck', ['--version']).status === 0;

function model(blocks: DocumentModel['blocks'] = []): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-07-15',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks,
    assets: {},
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}

describe('writeEpub', () => {
  it('declares a generated cover image and cover page while retaining the semantic title page', async () => {
    const cover: CoverComposition = {
      width: 1600,
      height: 2560,
      layout: 'typographic',
      title: 'Covered book',
      authors: ['Jane Smith'],
      alignment: 'center',
      titlePosition: 20,
      authorPosition: 85,
      titleSize: 112,
      authorSize: 54,
      textColor: 'light',
      contrastPanel: 'none',
      panelOpacity: 0.5,
      imageOpacity: 1,
      margin: 8,
      crop: 'cover',
    };
    const files = unzipSync(
      await writeEpub(model(), {
        conversionDate: '2026-07-16',
        identifier: 'urn:cover-test',
        title: 'Covered book',
        language: 'en',
        cover,
      }),
    );
    const opf = strFromU8(files['EPUB/package.opf'] ?? new Uint8Array());
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<itemref idref="cover-page"/>');
    expect(opf).toContain('<itemref idref="title-page"/>');
    expect(strFromU8(files['EPUB/cover.xhtml'] ?? new Uint8Array())).toContain(
      'alt="Cover for Covered book"',
    );
    expect(strFromU8(files['EPUB/cover.svg'] ?? new Uint8Array())).toContain(
      '<svg',
    );
  });
  it('writes the smallest complete EPUB 3 publication with injectable metadata', async () => {
    const output = await writeEpub(model(), {
      conversionDate: '2026-07-15',
      identifier: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
      title: 'A <safe> title',
      language: 'nl-NL',
      modified: '2026-07-15T08:30:00Z',
    });
    const files = unzipSync(output);

    expect(strFromU8(files.mimetype ?? new Uint8Array())).toBe(
      'application/epub+zip',
    );
    expect(Object.keys(files)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/nav.xhtml',
      'EPUB/styles.css',
      'EPUB/title.xhtml',
      'EPUB/chapter-001.xhtml',
    ]);
    expect(
      strFromU8(files['META-INF/container.xml'] ?? new Uint8Array()),
    ).toContain('full-path="EPUB/package.opf"');
    const opf = strFromU8(files['EPUB/package.opf'] ?? new Uint8Array());
    expect(opf).toContain('unique-identifier="pub-id"');
    expect(opf).toContain(
      '<dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>',
    );
    expect(opf).toContain('<dc:title>A &lt;safe&gt; title</dc:title>');
    expect(opf).toContain('<dc:language>nl-NL</dc:language>');
    expect(opf).toContain(
      '<meta property="dcterms:modified">2026-07-15T08:30:00Z</meta>',
    );
    expect(opf).toContain('<item id="nav" href="nav.xhtml"');
    expect(opf).toContain('<itemref idref="title-page"/>');
    expect(opf).toContain('<itemref idref="chapter-001"/>');
    expect(strFromU8(files['EPUB/title.xhtml'] ?? new Uint8Array())).toContain(
      '<h1>A &lt;safe&gt; title</h1>',
    );
    expect(output[8]).toBe(0);
    expect(output[9]).toBe(0);
    const firstNameLength = (output[26] ?? 0) | ((output[27] ?? 0) << 8);
    expect(strFromU8(output.slice(30, 30 + firstNameLength))).toBe('mimetype');
  });

  it('splits only at top-level document-section boundaries and builds heading navigation', async () => {
    const input = model([
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'Book' }] },
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'One' }] },
      {
        type: 'list',
        ordered: false,
        items: [
          {
            blocks: [
              {
                type: 'heading',
                level: 2,
                children: [{ type: 'text', text: 'Nested' }],
              },
            ],
          },
        ],
      },
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Two' }] },
      {
        type: 'heading',
        level: 3,
        children: [{ type: 'text', text: 'Detail' }],
      },
    ]);

    const files = unzipSync(
      await writeEpub(input, {
        conversionDate: '2026-07-15',
        identifier: 'book-id',
        title: 'Book',
        language: 'en',
      }),
    );

    expect(
      Object.keys(files).filter((path) => /chapter-\d+/.test(path)),
    ).toEqual([
      'EPUB/chapter-001.xhtml',
      'EPUB/chapter-002.xhtml',
      'EPUB/chapter-003.xhtml',
    ]);
    expect(
      strFromU8(files['EPUB/chapter-002.xhtml'] ?? new Uint8Array()),
    ).toContain('<ul><li><h2 id="nested">Nested</h2></li></ul>');
    const nav = strFromU8(files['EPUB/nav.xhtml'] ?? new Uint8Array());
    expect(nav).toContain('chapter-002.xhtml#one');
    expect(nav).toContain('chapter-002.xhtml#nested');
    expect(nav).toContain('chapter-003.xhtml#detail');
  });

  it('serializes model structures, local passive assets, notes, and metadata', async () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          {
            type: 'link',
            href: '#local',
            children: [{ type: 'text', text: ' link' }],
          },
          { type: 'image', assetId: 'photo', alt: 'A photo' },
          { type: 'equation', equationId: 'eq' },
          { type: 'noteReference', noteId: 'note' },
        ],
      },
      {
        type: 'table',
        rows: [
          {
            cells: [
              { header: true, blocks: [{ type: 'codeBlock', text: '<x>' }] },
            ],
          },
        ],
      },
      { type: 'blockquote', blocks: [{ type: 'thematicBreak' }] },
      {
        type: 'imageBlock',
        assetId: 'photo',
        caption: [{ type: 'text', text: 'Caption' }],
      },
      { type: 'pageBreak' },
    ]);
    input.metadata.authors.push({
      value: { name: 'Jane & John' },
      provenance: {
        source: 'test',
        method: 'extracted',
        confidence: 'certain',
      },
    });
    input.assets.photo = {
      id: 'photo',
      mediaType: 'image/png',
      filename: '../../bad.html',
      data: new Uint8Array([137, 80, 78, 71]),
    };
    input.assets.font = {
      id: 'font',
      mediaType: 'font/woff2',
      data: new Uint8Array([119, 79, 70, 50]),
    };
    input.equations.eq = {
      id: 'eq',
      source: { format: 'tex', value: 'x < y' },
      conversionComplete: true,
    };
    input.notes.note = {
      id: 'note',
      kind: 'footnote',
      blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Note' }] },
      ],
    };

    const output = await writeEpub(input, {
      conversionDate: '2026-07-15',
      identifier: 'book-id',
      title: 'Book',
      language: 'en',
    });
    const files = unzipSync(output);
    const chapter = strFromU8(
      files['EPUB/chapter-001.xhtml'] ?? new Uint8Array(),
    );
    const opf = strFromU8(files['EPUB/package.opf'] ?? new Uint8Array());

    expect(Object.keys(files)).toContain('EPUB/images/image-001.png');
    expect(Object.keys(files)).toContain('EPUB/fonts/font-001.woff2');
    expect(chapter).toContain('<strong>Bold</strong>');
    expect(chapter).toContain('src="images/image-001.png"');
    expect(chapter).toContain('<th><pre><code>&lt;x&gt;</code></pre></th>');
    expect(chapter).toContain('epub:type="footnote"');
    expect(chapter).toContain('<figcaption>Caption</figcaption>');
    expect(opf).toContain('href="images/image-001.png" media-type="image/png"');
    expect(opf).toContain('<dc:creator>Jane &amp; John</dc:creator>');
  });

  it('is deterministic and excludes active content, remote URLs, unsafe SVG, and undeclared resources', async () => {
    const input = model([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'javascript:alert(1)',
            children: [{ type: 'text', text: 'bad' }],
          },
          {
            type: 'link',
            href: 'https://evil.invalid/x',
            children: [{ type: 'text', text: 'remote' }],
          },
          { type: 'image', assetId: 'svg', alt: '" onload="bad' },
          { type: 'image', assetId: 'html', alt: 'bad' },
        ],
      },
    ]);
    input.assets.svg = {
      id: 'svg',
      mediaType: 'image/svg+xml',
      data: new TextEncoder().encode('<svg onload="alert(1)"/>'),
    };
    input.assets.html = {
      id: 'html',
      mediaType: 'text/html',
      data: new TextEncoder().encode('<iframe src="https://evil.invalid"/>'),
    };
    const options = {
      conversionDate: '2026-07-15',
      identifier: 'book-id',
      title: 'Book',
      language: 'en',
    } as const;

    const first = await writeEpub(input, options);
    const second = await writeEpub(input, options);
    const publicationText = Object.entries(unzipSync(first))
      .filter(([path]) => /\.(?:xhtml|opf|css|xml)$/.test(path))
      .map(([, bytes]) => strFromU8(bytes))
      .join('');

    expect(first).toEqual(second);
    expect(publicationText).not.toMatch(
      /javascript:|evil\.invalid|<script|onload=|<iframe|image\/svg\+xml|text\/html/i,
    );
    expect(publicationText).toContain('<p>badremote</p>');
  });

  it('rejects missing or invalid required EPUB metadata', async () => {
    await expect(
      writeEpub(model(), { conversionDate: '2026-07-15' }),
    ).rejects.toThrow('identifier');
    await expect(
      writeEpub(model(), {
        conversionDate: 'not-a-date',
        identifier: 'id',
        title: 'Book',
        language: 'en',
      }),
    ).rejects.toThrow('modified timestamp');
    await expect(
      writeEpub(model(), {
        conversionDate: '2026-07-15',
        identifier: 'id',
        title: 'Book',
        language: 'bad language',
      }),
    ).rejects.toThrow('language');
  });

  it.skipIf(!epubcheckAvailable)('passes EPUBCheck', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wordconvert-epub-'));
    const path = join(directory, 'fixture.epub');
    try {
      writeFileSync(
        path,
        await writeEpub(
          model([
            {
              type: 'heading',
              level: 1,
              children: [{ type: 'text', text: 'Chapter' }],
            },
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'Validated content.' }],
            },
          ]),
          {
            conversionDate: '2026-07-15',
            identifier: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
            title: 'Validated fixture',
            language: 'en',
          },
        ),
      );
      const result = spawnSync('epubcheck', [path], { encoding: 'utf8' });
      expect(`${result.stdout}${result.stderr}`).toContain(
        'No errors or warnings detected',
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
