import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  analysePdf,
  pdfJsReader,
  type RawPdfDocument,
  type RawPdfTextSpan,
} from './index.ts';
import { readImages, readSpans } from './pdfjs.ts';

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(
      fileURLToPath(
        new URL(`../../../tests/fixtures/pdf/${name}`, import.meta.url),
      ),
    ),
  );
}

function span(
  text: string,
  x: number,
  top: number,
  options: Partial<RawPdfTextSpan> = {},
): RawPdfTextSpan {
  return {
    id: `${text}-${x}-${top}`,
    text,
    x,
    top,
    width: 0.35,
    height: 0.02,
    fontId: 'body',
    fontFamily: 'Times',
    fontSize: 11,
    bold: false,
    italic: false,
    direction: 'ltr',
    ...options,
  };
}

function rawDocument(
  pages: RawPdfDocument['pages'],
  metadata: RawPdfDocument['metadata'] = {},
): RawPdfDocument {
  return {
    version: 1,
    pageCount: pages.length,
    pages,
    metadata,
    outline: [],
  };
}

describe('PDF layout analysis', () => {
  it('reads a two-column page down the left column before the right column', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span('Right second', 0.55, 0.2),
          span('Left first', 0.08, 0.1),
          span('Right first', 0.55, 0.1),
          span('Left second', 0.08, 0.2),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, {
      conversionDate: '2026-08-29',
      filename: 'article.pdf',
    });

    expect(
      result.model.blocks.map((block) =>
        block.type === 'paragraph'
          ? block.children
              .map((child) => (child.type === 'text' ? child.text : ''))
              .join('')
          : '',
      ),
    ).toEqual(['Left first', 'Left second', 'Right first', 'Right second']);
  });

  it('removes repeated odd/even headers and variable page-number footers', async () => {
    const pages = Array.from({ length: 4 }, (_, index) => {
      const number = index + 1;
      return {
        number,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span(
            number % 2 === 0 ? 'A Practical Book' : 'Chapter One',
            0.08,
            0.03,
          ),
          span(`Body page ${number}`, 0.08, 0.25),
          ...(number === 1 ? [span('Chapter One', 0.08, 0.4)] : []),
          span(`Page ${number} of 4`, 0.45, 0.96),
        ],
        links: [],
        images: [],
      };
    });

    const result = await analysePdf(rawDocument(pages), {
      conversionDate: '2026-08-29',
      filename: 'book.pdf',
    });
    const text = JSON.stringify(result.model.blocks);

    expect({
      text,
      candidates: result.analysis.candidates.map((candidate) => ({
        kind: candidate.kind,
        parity: candidate.pageParity,
        confidence: candidate.confidence,
        removed: candidate.removed,
      })),
    }).toMatchObject({
      text: expect.not.stringMatching(/A Practical Book|Page \d/),
      candidates: expect.arrayContaining([
        {
          kind: 'header',
          parity: 'odd',
          confidence: 'high',
          removed: true,
        },
        {
          kind: 'header',
          parity: 'even',
          confidence: 'high',
          removed: true,
        },
        {
          kind: 'page-number',
          parity: 'odd',
          confidence: 'high',
          removed: true,
        },
      ]),
    });
    expect(text.match(/Chapter One/g)).toHaveLength(1);
  });

  describe('PDF.js reader', () => {
    it('extracts PDF metadata and positioned text through the public reader', async () => {
      const raw = await pdfJsReader.readRaw(
        await fixture('one-column-book.pdf'),
        {
          conversionDate: '2026-08-29',
          filename: 'fixture.pdf',
        },
      );

      expect({
        metadata: raw.metadata,
        outline: raw.outline,
        text: raw.pages.flatMap(({ spans }) => spans.map(({ text }) => text)),
        coordinates: raw.pages[0]?.spans.every(
          ({ x, top }) => x >= 0 && x <= 1 && top >= 0 && top <= 1,
        ),
      }).toMatchObject({
        metadata: {
          title: 'A Practical Book',
          author: 'WordConvert fixture generator',
        },
        outline: [{ title: 'Chapter One' }],
        text: expect.arrayContaining([
          'A Practical Book',
          'Body paragraph on page 1.',
        ]),
        coordinates: true,
      });
    });

    it('extracts a deterministic representative page sample without images', async () => {
      const raw = await pdfJsReader.readRaw(
        await fixture('one-column-book.pdf'),
        {
          conversionDate: '2026-08-29',
          samplePageCount: 3,
        },
      );

      expect(raw.pageCount).toBe(6);
      expect(raw.pages.map(({ number }) => number)).toEqual([1, 4, 6]);
      expect(raw.pages.every(({ images }) => images.length === 0)).toBe(true);
    });

    it('preserves links, images, tagged structure, and scanned-page diagnostics', async () => {
      const [book, tagged, scanned] = await Promise.all([
        pdfJsReader.readRaw(await fixture('one-column-book.pdf'), {
          conversionDate: '2026-08-29',
        }),
        pdfJsReader.readRaw(await fixture('tagged-article.pdf'), {
          conversionDate: '2026-08-29',
        }),
        pdfJsReader.read(await fixture('scanned-page.pdf'), {
          conversionDate: '2026-08-29',
        }),
      ]);

      expect({
        link: book.pages[0]?.links[0]?.href,
        tagged: tagged.pages[0]?.taggedStructure?.role,
        markedContent: tagged.pages[0]?.spans[0]?.markedContentId,
        images: Object.keys(scanned.model.assets),
        warning: scanned.model.warnings.map(({ code }) => code),
      }).toMatchObject({
        link: 'https://example.com/',
        tagged: 'Root',
        markedContent: expect.any(String),
        images: ['pdf-image-1-0'],
        warning: ['pdf-ocr-not-supported'],
      });
    });

    it('is deterministic and rejects malformed, excessive, and cancelled input privately', async () => {
      const bytes = await fixture('two-column-article.pdf');
      const options = {
        conversionDate: '2026-08-29',
        filename: 'private-name.pdf',
        crop: { bottom: 0.05 },
      };
      const first = await pdfJsReader.read(bytes, options);
      const second = await pdfJsReader.read(bytes, options);
      expect(first).toEqual(second);
      const text = JSON.stringify(first.model.blocks);
      expect(text.indexOf('Left column second 1')).toBeLessThan(
        text.indexOf('Right column first 1'),
      );

      await expect(
        pdfJsReader.readRaw(await fixture('malformed.pdf'), options),
      ).rejects.toMatchObject({
        code: 'invalid-input',
        message: expect.not.stringContaining('private-name'),
      });
      await expect(
        pdfJsReader.readRaw(await fixture('encrypted.pdf'), options),
      ).rejects.toMatchObject({
        code: 'encrypted-document',
        message: expect.not.stringContaining('private-name'),
      });
      await expect(
        pdfJsReader.readRaw(bytes, {
          ...options,
          limits: { maxInputBytes: 10 },
        }),
      ).rejects.toMatchObject({ code: 'resource-limit' });
      await expect(
        pdfJsReader.readRaw(bytes, {
          ...options,
          cancellation: { cancelled: true },
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('applies explicit style mappings on a PDF rerun', async () => {
      const bytes = await fixture('one-column-book.pdf');
      const initial = await pdfJsReader.read(bytes, {
        conversionDate: '2026-08-29',
      });
      const headingStyle = initial.model.styles.find(
        ({ proposedMapping }) => proposedMapping === 'heading1',
      );
      if (!headingStyle) throw new Error('Expected a PDF heading style.');

      const rerun = await pdfJsReader.read(bytes, {
        conversionDate: '2026-08-29',
        styleMappings: { [headingStyle.id]: 'ignore' },
      });

      expect({
        text: JSON.stringify(rerun.model.blocks),
        style: rerun.model.styles.find(({ id }) => id === headingStyle.id),
      }).toMatchObject({
        text: expect.not.stringContaining('A Practical Book'),
        style: {
          proposedMapping: 'ignore',
          provenance: { method: 'user', confidence: 'certain' },
        },
      });
    });

    it('enforces configurable page, text-item, and image limits', async () => {
      const options = { conversionDate: '2026-08-29' };
      await expect(
        pdfJsReader.readRaw(await fixture('one-column-book.pdf'), {
          ...options,
          limits: { maxPages: 1 },
        }),
      ).rejects.toMatchObject({ code: 'resource-limit' });
      await expect(
        pdfJsReader.readRaw(await fixture('two-column-article.pdf'), {
          ...options,
          limits: { maxTextItems: 1 },
        }),
      ).rejects.toMatchObject({ code: 'resource-limit' });
      await expect(
        pdfJsReader.readRaw(await fixture('scanned-page.pdf'), {
          ...options,
          limits: { maxImagePixels: 0 },
        }),
      ).rejects.toMatchObject({ code: 'resource-limit' });
    });

    it('cancels while extracting a page', async () => {
      const cancellation = { cancelled: false };
      await expect(
        pdfJsReader.readRaw(await fixture('scanned-page.pdf'), {
          conversionDate: '2026-08-29',
          cancellation,
          onProgress(progress) {
            if (progress.phase === 'read' && progress.completed === 0)
              cancellation.cancelled = true;
          },
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('cancels during layout analysis', async () => {
      const cancellation = { cancelled: false };
      await expect(
        pdfJsReader.read(await fixture('one-column-book.pdf'), {
          conversionDate: '2026-08-29',
          cancellation,
          onProgress(progress) {
            if (progress.phase === 'analyse' && progress.completed === 0)
              cancellation.cancelled = true;
          },
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });
  });

  it('applies page-relative crop regions but keeps the boundary and short-document content', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 90,
          spans: [
            span('Cropped header', 0.1, 0.049),
            span('Boundary title', 0.1, 0.05, {
              fontSize: 20,
              height: 0.02,
            }),
            span('Body', 0.1, 0.4),
            span('Cropped footer', 0.1, 0.94, { height: 0.02 }),
          ],
          links: [],
          images: [],
        },
      ]),
      {
        conversionDate: '2026-08-29',
        crop: { top: 0.05, bottom: 0.05 },
      },
    );

    expect(JSON.stringify(result.model.blocks)).toContain('Boundary title');
    expect(JSON.stringify(result.model.blocks)).not.toMatch(
      /Cropped header|Cropped footer/,
    );
    expect(result.analysis.candidates).toEqual([]);
  });

  it('keeps positioned images when nearby text is cropped', async () => {
    const pixels = Uint8Array.from([0, 0, 0, 255]);
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [span('Body', 0.1, 0.4)],
          links: [],
          images: [
            {
              id: 'header-image',
              x: 0.1,
              top: 0.01,
              width: 0.1,
              height: 0.02,
              pixelWidth: 1,
              pixelHeight: 1,
              mediaType: 'image/png',
              data: pixels,
            },
            {
              id: 'body-image',
              x: 0.1,
              top: 0.4,
              width: 0.1,
              height: 0.1,
              pixelWidth: 1,
              pixelHeight: 1,
              mediaType: 'image/png',
              data: pixels,
            },
          ],
        },
      ]),
      { conversionDate: '2026-08-29', crop: { top: 0.05 } },
    );

    expect(Object.keys(result.model.assets)).toEqual([
      'header-image',
      'body-image',
    ]);
    expect(JSON.stringify(result.model.blocks)).toContain('header-image');
  });

  it('places images between surrounding text on the same page', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Before image', 0.1, 0.1),
            span('After image', 0.1, 0.5),
          ],
          links: [],
          images: [
            {
              id: 'middle-image',
              x: 0.1,
              top: 0.3,
              width: 0.2,
              height: 0.1,
              pixelWidth: 1,
              pixelHeight: 1,
              mediaType: 'image/png',
              data: Uint8Array.from([0]),
            },
          ],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.map(({ type }) => type)).toEqual([
      'paragraph',
      'imageBlock',
      'paragraph',
    ]);
  });

  it('uses tagged structure and whitespace to reconstruct semantic blocks', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Tagged heading', 0.1, 0.1, {
              markedContentId: 'mc-heading',
            }),
            span('Wrapped first line', 0.1, 0.2),
            span('continues here.', 0.1, 0.225),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'H2',
                children: [
                  {
                    role: 'NonStruct',
                    markedContentId: 'mc-heading',
                    children: [],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toMatchObject([
      { type: 'heading', level: 2 },
      {
        type: 'paragraph',
        children: [
          { text: 'Wrapped first line' },
          { text: ' ' },
          { text: 'continues here.' },
        ],
      },
    ]);
  });

  it('uses tagged structure order ahead of geometric order', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Logical second', 0.1, 0.1, {
              markedContentId: 'mc-second',
            }),
            span('Logical first', 0.1, 0.3, {
              markedContentId: 'mc-first',
            }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'P',
                markedContentId: 'mc-first',
                children: [],
              },
              {
                role: 'P',
                markedContentId: 'mc-second',
                children: [],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(
      JSON.stringify(result.model.blocks).indexOf('Logical first'),
    ).toBeLessThan(
      JSON.stringify(result.model.blocks).indexOf('Logical second'),
    );
  });

  it('retains medium-confidence furniture until the user explicitly removes it', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      spans: [
        ...(index === 0 || index === 2
          ? [span('Occasional chapter label', 0.1, 0.03)]
          : []),
        span(`Body ${index + 1}`, 0.1, 0.3),
      ],
      links: [],
      images: [],
    }));
    const initial = await analysePdf(rawDocument(pages), {
      conversionDate: '2026-08-29',
    });
    const candidate = initial.analysis.candidates[0];
    if (!candidate) throw new Error('Expected a furniture candidate.');

    const overridden = await analysePdf(rawDocument(pages), {
      conversionDate: '2026-08-29',
      removedCandidateIds: [candidate.id],
    });

    expect({
      confidence: candidate.confidence,
      initiallyRemoved: candidate.removed,
      initialText: JSON.stringify(initial.model.blocks),
      overriddenText: JSON.stringify(overridden.model.blocks),
    }).toMatchObject({
      confidence: 'medium',
      initiallyRemoved: false,
      initialText: expect.stringContaining('Occasional chapter label'),
      overriddenText: expect.not.stringContaining('Occasional chapter label'),
    });
  });

  it('removes only the exact furniture candidate selected by the user', async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      number: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      spans: [
        ...(index % 2 === 0
          ? [
              span('Repeated label', 0.05, 0.03, { width: 0.2 }),
              span('Repeated label', 0.75, 0.03, { width: 0.2 }),
            ]
          : []),
        span(`Body ${index + 1}`, 0.1, 0.3),
      ],
      links: [],
      images: [],
    }));
    const initial = await analysePdf(rawDocument(pages), {
      conversionDate: '2026-08-29',
      removeDetectedFurniture: false,
    });
    const [removed, retained] = initial.analysis.candidates;
    if (!removed || !retained) throw new Error('Expected two candidates.');

    const result = await analysePdf(rawDocument(pages), {
      conversionDate: '2026-08-29',
      removeDetectedFurniture: false,
      removedCandidateIds: [removed.id],
      retainedCandidateIds: [retained.id],
    });
    const text = JSON.stringify(result.model.blocks);

    expect(text.match(/Repeated label/g)).toHaveLength(4);
  });
});

describe('PDF.js extraction helpers', () => {
  it('normalizes rotated text from transformed bounding-box corners', () => {
    const spans = readSpans(
      {
        items: [
          {
            str: 'Rotated',
            dir: 'ltr',
            transform: [10, 0, 0, 10, 20, 30],
            width: 40,
            height: 10,
            fontName: 'f1',
            hasEOL: false,
          },
        ],
        styles: { f1: { fontFamily: 'Times' } },
        lang: null,
      } as never,
      [],
      100,
      200,
      [0, 1, 1, 0, 0, 0],
    );

    expect(spans[0]).toMatchObject({
      x: 0.3,
      top: 0.1,
      width: 0.1,
      height: 0.2,
    });
  });

  it('extracts inline and grouped inline image operations', async () => {
    const image = {
      width: 1,
      height: 1,
      kind: 3,
      data: Uint8Array.from([10, 20, 30, 255]),
    };
    const page = {
      pageNumber: 1,
      getViewport: () => ({ width: 100, height: 100 }),
      objs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(image),
      },
      getOperatorList: async () => ({
        fnArray: [
          OPS.paintInlineImageXObject,
          OPS.paintInlineImageXObjectGroup,
          OPS.paintImageXObjectRepeat,
        ],
        argsArray: [
          [image],
          [
            {
              width: 3,
              height: 1,
              kind: 3,
              data: Uint8Array.from([
                10, 20, 30, 255, 0, 0, 0, 0, 40, 50, 60, 255,
              ]),
            },
            [
              { transform: [1, 0, 0, 1, 10, 10], x: 0, y: 0, w: 1, h: 1 },
              { transform: [1, 0, 0, 1, 20, 20], x: 2, y: 0, w: 1, h: 1 },
            ],
          ],
          ['repeated', 1, 1, Float32Array.from([30, 30, 40, 40])],
        ],
      }),
    };

    const images = await readImages(page as never, [1, 0, 0, 1, 0, 0], {
      maxInputBytes: 1,
      maxPages: 1,
      maxTextItems: 1,
      maxTextItemsPerPage: 1,
      maxImages: 10,
      maxImagePixels: 10,
      maxTotalImagePixels: 10,
    });

    expect(images).toHaveLength(5);
    expect(
      images.map(({ pixelWidth, pixelHeight }) => [pixelWidth, pixelHeight]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });

  it('limits aggregate repeated-image placements', async () => {
    const image = {
      width: 1,
      height: 1,
      kind: 3,
      data: Uint8Array.from([10, 20, 30, 255]),
    };
    const page = {
      pageNumber: 1,
      getViewport: () => ({ width: 100, height: 100 }),
      objs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(image),
      },
      getOperatorList: async () => ({
        fnArray: [OPS.paintImageXObjectRepeat],
        argsArray: [['repeated', 1, 1, Float32Array.from([10, 10, 20, 20])]],
      }),
    };

    await expect(
      readImages(page as never, [1, 0, 0, 1, 0, 0], {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 1,
        maxImagePixels: 10,
        maxTotalImagePixels: 10,
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
  });
});
