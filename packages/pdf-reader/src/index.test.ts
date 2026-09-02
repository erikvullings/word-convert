import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  analysePdf,
  createFormulaCandidates,
  pdfJsReader,
  type RawPdfDocument,
  type RawPdfTextSpan,
} from './index.ts';
import { readImages, readSpans, recognizeFormulaCandidates } from './pdfjs.ts';

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
  it('recognizes complex formulas from bounded rendered pixels and disposes the crop', async () => {
    const formula = span('x = √y', 0.22, 0.3, { width: 0.1 });
    const candidate = createFormulaCandidates({
      page: 1,
      spans: [formula],
    })[0]!;
    const dispose = vi.fn();
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const recognize = vi.fn(
      async (image: {
        width: number;
        height: number;
        rgba: Uint8ClampedArray;
      }) => {
        expect(dispose).toHaveBeenCalledOnce();
        expect(image.width * image.height).toBeLessThanOrEqual(20_000);
        expect(image.rgba[0]).toBe(160);
        return { tex: '\\sqrt{y}', diagnostics: { tokens: 4 } };
      },
    );

    const recognized = await recognizeFormulaCandidates(
      {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render,
      } as never,
      [candidate],
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(160),
          encodePng: async () => new Uint8Array(),
          dispose,
        }),
      },
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 20_000,
        maxTotalCropPixels: 20_000,
        maxRecognitionTokens: 10,
      },
    );

    expect(render).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(recognized[0]?.recognition).toMatchObject({
      tex: '\\sqrt{y}',
      model: 'test-model',
      reviewConfidence: expect.stringMatching(/^(?:low|medium|high)$/),
    });
  });

  it('does not invoke recognition for deterministic formula candidates', async () => {
    const formula = span('x = 5', 0.45, 0.3, { width: 0.1 });
    const candidate = createFormulaCandidates({
      page: 1,
      spans: [formula],
    })[0]!;
    const recognize = vi.fn();

    const recognized = await recognizeFormulaCandidates(
      {} as never,
      [candidate],
      {} as never,
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 20_000,
        maxTotalCropPixels: 20_000,
        maxRecognitionTokens: 10,
      },
    );

    expect(recognize).not.toHaveBeenCalled();
    expect(recognized).toEqual([candidate]);
  });

  it('constructs a semantic equation from simple PDF text geometry', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Before', 0.1, 0.3, { width: 0.08 }),
            span('x = 5', 0.22, 0.3, { width: 0.1 }),
            span('after.', 0.36, 0.3, { width: 0.08 }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-09-02' },
    );

    expect(result.model.equations['pdf-equation-p1-001']).toMatchObject({
      tex: 'x = 5',
      display: 'inline',
      recognition: { method: 'pdf-text' },
      location: { kind: 'pdf', page: 1 },
    });
    expect(result.model.blocks).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        children: [
          expect.objectContaining({ type: 'text', text: 'Before' }),
          { type: 'equation', equationId: 'pdf-equation-p1-001' },
          expect.objectContaining({ type: 'text', text: 'after.' }),
        ],
      }),
    ]);
  });

  it('restores source text when a deterministic formula decision rejects a candidate', async () => {
    const page = {
      number: 1,
      width: 600,
      height: 800,
      rotation: 0,
      spans: [span('x = 5', 0.22, 0.3, { width: 0.1 })],
      links: [],
      images: [],
    };
    const result = await analysePdf(rawDocument([page]), {
      conversionDate: '2026-09-02',
      formulaDecisions: {
        'pdf-equation-p1-001': {
          equationId: 'pdf-equation-p1-001',
          decision: 'text',
        },
      },
    });

    expect(result.model.equations).toEqual({});
    expect(result.model.blocks[0]).toMatchObject({
      type: 'paragraph',
      children: [expect.objectContaining({ type: 'text', text: 'x = 5' })],
    });
  });

  it('preserves original recognized TeX when a user edit reruns analysis', async () => {
    const formula = span('x = √y', 0.22, 0.3, { width: 0.1 });
    const detected = createFormulaCandidates({ page: 1, spans: [formula] })[0]!;
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [],
          formulaCandidates: [
            {
              ...detected,
              recognition: {
                tex: '\\sqrt{y}',
                model: 'rapid-latex-ocr-onnx',
                reviewConfidence: 'medium',
              },
            },
          ],
        },
      ]),
      {
        conversionDate: '2026-09-02',
        formulaDecisions: {
          [detected.id]: {
            equationId: detected.id,
            decision: 'formula',
            tex: '\\sqrt{y} + 1',
          },
        },
      },
    );

    expect(result.model.equations[detected.id]).toMatchObject({
      tex: '\\sqrt{y} + 1',
      recognition: { method: 'user' },
      review: { status: 'edited', originalTex: '\\sqrt{y}' },
    });
  });

  it('constructs a block node for an isolated centered formula', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [span('x = 5', 0.45, 0.3, { width: 0.1 })],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-09-02' },
    );

    expect(result.model.blocks).toContainEqual({
      type: 'equationBlock',
      equationId: 'pdf-equation-p1-001',
    });
    expect(result.model.equations['pdf-equation-p1-001']?.display).toBe(
      'block',
    );
  });

  it('retains complex source text and warns when an injected recognizer fails', async () => {
    const formula = span('x = √y', 0.22, 0.3, { width: 0.1 });
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [],
          formulaCandidates: [
            {
              ...createFormulaCandidates({ page: 1, spans: [formula] })[0]!,
              recognitionFailure: 'failed',
            },
          ],
        },
      ]),
      { conversionDate: '2026-09-02' },
    );

    expect(result.model.equations).toEqual({});
    expect(result.model.blocks[0]).toMatchObject({
      type: 'paragraph',
      children: [expect.objectContaining({ type: 'text', text: 'x = √y' })],
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-formula-recognition-failed' }),
    );
  });

  it('retains source text when recognition exceeds the token limit', async () => {
    const formula = span('x = √y', 0.22, 0.3, { width: 0.1 });
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [],
          formulaCandidates: [
            {
              ...createFormulaCandidates({ page: 1, spans: [formula] })[0]!,
              recognitionFailure: 'limit-exceeded',
            },
          ],
        },
      ]),
      {
        conversionDate: '2026-09-02',
      },
    );

    expect(result.model.equations).toEqual({});
    expect(result.model.blocks[0]).toMatchObject({
      children: [expect.objectContaining({ text: 'x = √y' })],
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-formula-limit-exceeded' }),
    );
  });

  it('retains source text when recognition returns malformed TeX', async () => {
    const formula = span('x = √y', 0.22, 0.3, { width: 0.1 });
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [],
          formulaCandidates: [
            {
              ...createFormulaCandidates({ page: 1, spans: [formula] })[0]!,
              recognitionFailure: 'invalid-tex',
            },
          ],
        },
      ]),
      {
        conversionDate: '2026-09-02',
      },
    );

    expect(result.model.equations).toEqual({});
    expect(result.model.blocks[0]).toMatchObject({
      children: [expect.objectContaining({ text: 'x = √y' })],
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-formula-invalid-tex' }),
    );
  });

  it('preserves extracted Heron evidence through deterministic analysis', async () => {
    const formula = span('x = 5', 0.45, 0.3, { width: 0.1 });
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [],
          formulaCandidates: [
            {
              ...createFormulaCandidates({ page: 1, spans: [formula] })[0]!,
              sources: ['heron', 'geometry', 'symbols'],
            },
          ],
        },
      ]),
      { conversionDate: '2026-09-02' },
    );

    expect(result.analysis.formulaCandidates?.[0]?.sources).toContain('heron');
  });

  it('infers a multiline visible title instead of using an Office source filename', async () => {
    const raw = rawDocument(
      [
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Accelerate Innovation with', 0.2, 0.1, {
              fontSize: 28,
              height: 0.03,
            }),
            span('TRIZ', 0.2, 0.14, { fontSize: 28, height: 0.03 }),
            span('Article body', 0.2, 0.3),
          ],
          links: [],
          images: [],
        },
      ],
      { title: 'Microsoft Word - AccelerateInnovationWithTRIZ.doc' },
    );

    const result = await analysePdf(raw, {
      conversionDate: '2026-08-29',
      filename: 'article.pdf',
    });

    expect(result.model.metadata.title).toMatchObject({
      value: 'Accelerate Innovation with TRIZ',
      provenance: { method: 'inferred' },
    });
  });

  it('generates a stable identifier from the PDF filename', async () => {
    const result = await analysePdf(rawDocument([]), {
      conversionDate: '2026-08-29',
      filename: 'Accelerate Innovation with TRIZ.pdf',
    });

    expect(result.model.metadata.identifier).toMatchObject({
      value: 'urn:wordconvert:accelerate-innovation-with-triz',
      provenance: {
        source: 'filename',
        method: 'inferred',
        confidence: 'low',
      },
    });
  });

  it('merges adjacent lines mapped to the same heading', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span('Accelerate Innovation with', 0.2, 0.1, {
            fontSize: 28,
            height: 0.03,
          }),
          span('TRIZ', 0.2, 0.14, { fontSize: 28, height: 0.03 }),
          span('Article body', 0.2, 0.3),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, {
      conversionDate: '2026-08-29',
      styleMappings: { 'pdf-body-28-regular-roman': 'heading1' },
    });
    const headings = result.model.blocks.filter(
      (block) => block.type === 'heading',
    );

    expect(headings).toHaveLength(1);
    expect(headings[0]?.children).toEqual([
      { type: 'text', text: 'Accelerate Innovation with' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'TRIZ' },
    ]);
  });

  it('keeps heading-styled author and email lines as a byline paragraph', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span('Article title', 0.2, 0.1, {
            fontSize: 28,
            height: 0.03,
          }),
          span('Valeri Souchkov, 2007', 0.2, 0.2, {
            fontSize: 14,
            height: 0.017,
          }),
          span('valeri@example.com', 0.2, 0.23, {
            fontSize: 14,
            height: 0.017,
          }),
          span('Article body', 0.2, 0.3),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, {
      conversionDate: '2026-08-29',
      styleMappings: {
        'pdf-body-28-regular-roman': 'heading1',
        'pdf-body-14-regular-roman': 'heading2',
      },
    });

    expect(
      result.model.blocks.map((block) => ({
        type: block.type,
        text:
          block.type === 'heading' || block.type === 'paragraph'
            ? block.children
                .map((child) => (child.type === 'text' ? child.text : ''))
                .join('')
            : '',
      })),
    ).toEqual([
      { type: 'heading', text: 'Article title' },
      {
        type: 'paragraph',
        text: 'Valeri Souchkov, 2007 valeri@example.com',
      },
      { type: 'paragraph', text: 'Article body' },
    ]);
  });

  it('merges text-box lines when parallel diagram labels interleave', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span('Left box first', 0.34, 0.6, {
            width: 0.16,
            height: 0.01,
          }),
          span('Right box first', 0.62, 0.605, {
            width: 0.16,
            height: 0.01,
          }),
          span('Left box second', 0.35, 0.615, {
            width: 0.15,
            height: 0.01,
          }),
          span('Right box second', 0.63, 0.62, {
            width: 0.15,
            height: 0.01,
          }),
          span('Centered diagram caption', 0.38, 0.65, {
            width: 0.36,
            height: 0.01,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, {
      conversionDate: '2026-08-29',
    });

    expect(
      result.model.blocks.map((block) =>
        block.type === 'paragraph'
          ? block.children
              .map((child) => (child.type === 'text' ? child.text : ''))
              .join('')
          : '',
      ),
    ).toEqual([
      'Left box first Left box second',
      'Right box first Right box second',
      'Centered diagram caption',
    ]);
  });

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

    it('reports progress across representative extraction and analysis', async () => {
      const messages: string[] = [];

      await pdfJsReader.read(await fixture('one-column-book.pdf'), {
        conversionDate: '2026-08-29',
        samplePageCount: 3,
        onProgress: ({ message }) => {
          if (message) messages.push(message);
        },
      });

      expect(messages).toEqual(
        expect.arrayContaining([
          'Reading PDF page 1.',
          'Reading PDF page 4.',
          'Reading PDF page 6.',
          'Analysing PDF page 1.',
          'Analysing PDF page 4.',
          'Analysing PDF page 6.',
          'Detecting repeated page content.',
          'Applying PDF cleanup choices.',
          'Ordering PDF page 1.',
          'Analysing PDF styles.',
          'Building the document.',
        ]),
      );
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
    expect(result.model.blocks[1]).toEqual({
      type: 'imageBlock',
      assetId: 'middle-image',
      width: 0.2,
      alignment: 'left',
    });
  });

  it('places a centered figure before its following caption', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Figure 1: Model architecture.', 0.34, 0.51, {
              width: 0.31,
            }),
            span('Following explanation.', 0.18, 0.55, { width: 0.65 }),
          ],
          links: [],
          images: [
            {
              id: 'figure-1',
              x: 0.32,
              top: 0.09,
              width: 0.36,
              height: 0.41,
              pixelWidth: 100,
              pixelHeight: 100,
              mediaType: 'image/png',
              data: Uint8Array.from([0]),
            },
          ],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.map(({ type }) => type)).toEqual([
      'imageBlock',
      'paragraph',
      'paragraph',
    ]);
    expect(result.model.blocks[0]).toEqual({
      type: 'imageBlock',
      assetId: 'figure-1',
      width: 0.36,
      alignment: 'center',
    });
  });

  it('expands near-page-width PDF images to the available output width', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [],
          links: [],
          images: [
            {
              id: 'wide-image',
              x: 0.1,
              top: 0.2,
              width: 0.8,
              height: 0.3,
              pixelWidth: 800,
              pixelHeight: 300,
              mediaType: 'image/png',
              data: Uint8Array.from([0]),
            },
          ],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks[0]).toEqual({
      type: 'imageBlock',
      assetId: 'wide-image',
      width: 1,
      alignment: 'center',
    });
  });

  it('recognises academic headings and preserves bold lead-in fonts', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Abstract', 0.4, 0.1, { fontSize: 12, width: 0.1 }),
            span('Summary text.', 0.18, 0.14, { fontSize: 10 }),
            span('1 Introduction', 0.18, 0.2, { fontSize: 12 }),
            span('3.1 Encoder and Decoder Stacks', 0.18, 0.3, {
              fontSize: 10,
            }),
            span('Encoder:', 0.18, 0.35, {
              fontSize: 10,
              width: 0.08,
              bold: true,
            }),
            span('The encoder is composed of layers.', 0.27, 0.35, {
              fontSize: 10,
              width: 0.4,
            }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toMatchObject([
      { type: 'heading', level: 1 },
      { type: 'paragraph' },
      { type: 'heading', level: 1 },
      { type: 'heading', level: 2 },
      {
        type: 'paragraph',
        children: [
          { text: 'Encoder:', marks: [{ type: 'bold' }] },
          { text: ' ' },
          { text: 'The encoder is composed of layers.' },
        ],
      },
    ]);
  });

  it('cleans Word-style TOC leaders and links entries to matching sections', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Contents', 0.18, 0.1, { fontSize: 16 }),
            span('1. Introduction ........................ 3', 0.18, 0.15),
            span(
              '1.1. General Principles ........ 4 1.2. Missing Section ........ 5',
              0.18,
              0.18,
              { width: 0.7 },
            ),
          ],
          links: [],
          images: [],
        },
        {
          number: 2,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('1. Introduction', 0.18, 0.1, { fontSize: 16 }),
            span('Body.', 0.18, 0.15),
            span('1.1. General Principles', 0.18, 0.2, { fontSize: 14 }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-31' },
    );

    expect(result.model.blocks.slice(1, 4)).toMatchObject([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: '#1-introduction',
            children: [{ type: 'text', text: '1. Introduction' }],
          },
        ],
      },
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: '#1-1-general-principles',
            children: [{ type: 'text', text: '1.1. General Principles' }],
          },
        ],
      },
      {
        type: 'paragraph',
        children: [{ type: 'text', text: '1.2. Missing Section' }],
      },
    ]);
    expect(JSON.stringify(result.model.blocks)).not.toMatch(
      /\.{3,}|Section \.{2,} 5/,
    );
    expect(result.model.blocks).toContainEqual(
      expect.objectContaining({
        type: 'heading',
        id: '1-introduction',
      }),
    );
  });

  it('converts flattened PDF bullet glyphs into a semantic list', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('', 0.15, 0.18, { width: 0.01 }),
            span('Clarification', 0.18, 0.18, {
              width: 0.12,
              bold: true,
            }),
            span(': Is it clear what the tasking means?', 0.3, 0.18),
            span('', 0.15, 0.2, { width: 0.01 }),
            span('Widening: Does the tasking need to be broader?', 0.18, 0.2),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-31' },
    );

    expect(result.model.blocks).toMatchObject([
      {
        type: 'list',
        ordered: false,
        items: [
          {
            blocks: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'text',
                    text: 'Clarification:',
                    marks: [{ type: 'bold' }],
                  },
                  {
                    type: 'text',
                    text: ' Is it clear what the tasking means?',
                  },
                ],
              },
            ],
          },
          {
            blocks: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'text',
                    text: 'Widening: Does the tasking need to be broader?',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(JSON.stringify(result.model.blocks)).not.toContain('');
  });

  it('keeps numbered footnotes and sentence-like matrix explanations as paragraphs', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('2.2 Rich Picture Example', 0.18, 0.1, { fontSize: 12 }),
            span('Representative body text one.', 0.1, 0.18),
            span('Representative body text two.', 0.1, 0.23),
            span('Representative body text three.', 0.1, 0.28),
            span('Representative body text four.', 0.1, 0.33),
            span('Representative body text five.', 0.1, 0.36),
            span(
              '2. FCR: Fire Control Radar DEPENDS ON POL: Fuel to function so the corresponding cell is annotated with R.',
              0.1,
              0.4,
              { width: 0.8, fontSize: 20 },
            ),
            span(
              '6. Comms: Communications 7. POL: Fuel 8. SHORAD: Short Range Air Defence',
              0.1,
              0.5,
              { width: 0.8, fontSize: 20 },
            ),
            span('1 PWR 1 0 2 TTR 1 0 3 FCR 1 1 1', 0.1, 0.6, {
              width: 0.8,
              fontSize: 20,
            }),
            span(
              '1 To better understand this component, see the ICEBERG model (section 2.6).',
              0.1,
              0.92,
              { width: 0.8, fontSize: 20 },
            ),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-31' },
    );

    const blockContaining = (text: string) =>
      result.model.blocks.find((block) => JSON.stringify(block).includes(text));
    expect(blockContaining('Rich Picture')).toMatchObject({ type: 'heading' });
    expect(blockContaining('Fire Control Radar')).toMatchObject({
      type: 'paragraph',
    });
    expect(blockContaining('Communications')).toMatchObject({
      type: 'paragraph',
    });
    expect(blockContaining('PWR')).toMatchObject({ type: 'paragraph' });
    expect(blockContaining('ICEBERG')).toMatchObject({ type: 'paragraph' });
  });

  it('drops detached small formula fragments from flowing prose', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Body text.', 0.18, 0.1, { fontSize: 10 }),
            span('1 n', 0.2, 0.2, { fontSize: 7, width: 0.03 }),
            span('1 m', 0.7, 0.3, { fontSize: 7, width: 0.03 }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(JSON.stringify(result.model.blocks)).toContain('Body text.');
    expect(JSON.stringify(result.model.blocks)).not.toMatch(/1 [nm]/);
  });

  it('keeps a lowered inline subscript with its surrounding text', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('dimension d', 0.18, 0.1, {
              fontSize: 10,
              height: 0.013,
              width: 0.12,
            }),
            span('model', 0.3, 0.106, {
              fontSize: 7,
              height: 0.009,
              width: 0.04,
            }),
            span('= 512.', 0.34, 0.1, {
              fontSize: 10,
              height: 0.013,
              width: 0.06,
            }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    const first = result.model.blocks[0];
    expect(
      first && 'children' in first
        ? first.children
            .map((child) => ('text' in child ? child.text : ''))
            .join('')
        : '',
    ).toBe('dimension dmodel= 512.');
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

  it('merges a lowercase paragraph continuation across a page boundary', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'Modern TRIZ offers techniques and generates new concepts in a systematic',
              0.1,
              0.92,
              { width: 0.8 },
            ),
          ],
          links: [],
          images: [],
        },
        {
          number: 2,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'way. In addition, these techniques structure the innovation process.',
              0.1,
              0.08,
              { width: 0.78 },
            ),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toMatchObject([
      {
        type: 'paragraph',
        children: [
          {
            text: 'Modern TRIZ offers techniques and generates new concepts in a systematic',
          },
          { text: ' ' },
          {
            text: 'way. In addition, these techniques structure the innovation process.',
          },
        ],
      },
    ]);
  });

  it('merges an all-caps first word across a page boundary', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'The method is commonly known throughout the field as',
              0.1,
              0.92,
              {
                width: 0.8,
              },
            ),
          ],
          links: [],
          images: [],
        },
        {
          number: 2,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('TRIZ and remains widely used.', 0.1, 0.08, { width: 0.78 }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.map(({ type }) => type)).toEqual(['paragraph']);
  });

  it.each([
    [
      'ends with sentence punctuation',
      'A complete sentence.',
      'another paragraph',
    ],
    [
      'starts the next page with uppercase text',
      'An incomplete thought',
      'Another paragraph',
    ],
  ])('keeps page breaks when text %s', async (_case, ending, beginning) => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [span(ending, 0.1, 0.92, { width: 0.8 })],
          links: [],
          images: [],
        },
        {
          number: 2,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [span(beginning, 0.1, 0.08, { width: 0.78 })],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.map(({ type }) => type)).toEqual([
      'paragraph',
      'pageBreak',
      'paragraph',
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
        styles: { f1: { fontFamily: 'Times', ascent: 0.8, descent: -0.2 } },
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
      baseline: 0.1,
      ascent: 0.04,
      descent: -0.01,
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

  it('rasterizes a dense vector region instead of exposing component images', async () => {
    const component = {
      width: 4,
      height: 4,
      kind: 3,
      data: new Uint8Array(4 * 4 * 4).fill(255),
    };
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const dispose = vi.fn();
    const page = {
      pageNumber: 1,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 100 * scale,
      }),
      render,
      objs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(component),
      },
      getOperatorList: async () => ({
        fnArray: [
          OPS.constructPath,
          OPS.constructPath,
          OPS.constructPath,
          OPS.constructPath,
          OPS.save,
          OPS.transform,
          OPS.paintImageXObject,
          OPS.restore,
        ],
        argsArray: [
          [20, [], Float32Array.from([10, 10, 35, 35])],
          [20, [], Float32Array.from([30, 10, 55, 35])],
          [20, [], Float32Array.from([10, 30, 35, 55])],
          [20, [], Float32Array.from([30, 30, 55, 55])],
          undefined,
          [20, 0, 0, 20, 20, 20],
          ['component'],
          undefined,
        ],
      }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 10,
        maxImagePixels: 1_000_000,
        maxTotalImagePixels: 1_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose,
        }),
      },
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-figure-1-0',
        source: 'rendered-figure',
        mediaType: 'image/png',
      }),
    ]);
    expect(render).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rasterizes a captioned figure reported as one vector path', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 15,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({
        fnArray: [OPS.constructPath],
        argsArray: [
          [
            Int32Array.from([20]),
            Float32Array.from([60, 160, 540, 600]),
            Float32Array.from([60, 160, 540, 600]),
          ],
        ],
      }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('(NU) Figure 06: SSIM Dependency Table', 0.3, 0.76, {
          width: 0.4,
        }),
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-figure-15-0',
        source: 'rendered-figure',
      }),
    ]);
    expect(render).toHaveBeenCalledOnce();
  });

  it('keeps an ordinary caption outside a recovered figure', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 6,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('Introductory prose above the figure.', 0.1, 0.12, {
          width: 0.8,
          height: 0.03,
        }),
        span('1 PWR 2 TTR 3 FCR 4 EW 5 CSS', 0.15, 0.36, { width: 0.7 }),
        span('Y↓ 10 9 8 7 6 5 4 3 2 1', 0.15, 0.42, { width: 0.7 }),
        span('(NU) Figure 06: SSIM Dependency Table', 0.3, 0.78, {
          width: 0.4,
        }),
        span('Source: Cranfield University', 0.35, 0.81, { width: 0.3 }),
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-figure-6-0',
        source: 'rendered-figure',
        top: expect.closeTo(0.153, 3),
        height: expect.closeTo(0.625, 3),
      }),
    ]);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('includes caption and credit when pixels show they are inside the artwork', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 7,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(160),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('Introductory prose above the figure.', 0.1, 0.12, {
          width: 0.8,
          height: 0.03,
        }),
        span('Diagram content', 0.15, 0.36, { width: 0.7 }),
        span('(NU) Figure 01: Production Stages', 0.3, 0.78, {
          width: 0.4,
        }),
        span('Source: SHAPE J2T', 0.35, 0.81, { width: 0.3 }),
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-figure-7-0',
        source: 'rendered-figure',
        top: expect.closeTo(0.153, 3),
        height: expect.closeTo(0.681, 3),
      }),
    ]);
    expect(render).toHaveBeenCalledOnce();
  });

  it('recovers each captioned figure independently on a shared page', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 8,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('Introductory prose.', 0.1, 0.05, { height: 0.02 }),
        span('First table labels', 0.15, 0.14, { width: 0.7 }),
        span('Figure 06: Dependency Table', 0.3, 0.35, { width: 0.4 }),
        span('Source: University', 0.35, 0.38, { width: 0.3 }),
        span('Rules prose between figures.', 0.1, 0.44, { width: 0.8 }),
        span('Second table labels', 0.15, 0.56, { width: 0.7 }),
        span('Figure 07: Dependency Rules', 0.3, 0.82, { width: 0.4 }),
        span('Source: University', 0.35, 0.85, { width: 0.3 }),
      ],
    );

    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      top: expect.closeTo(0.073, 3),
      height: expect.closeTo(0.275, 3),
    });
    expect(images[1]).toMatchObject({
      top: expect.closeTo(0.463, 3),
      height: expect.closeTo(0.355, 3),
    });
  });

  it('recovers a near-full-page table without cutting at internal row gaps', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 10,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('1 2 3 4 5 6 7 8 9 10', 0.08, 0.05, { width: 0.84 }),
        span('1 PWR 1 0 0 0 0 0 0 0 0 0', 0.08, 0.14, { width: 0.84 }),
        span('5 CSS 0 0 0 0 1 1 1 1 0 0', 0.08, 0.48, { width: 0.84 }),
        span('Driving power 3 3 2 1 3 7 6 2 1 1', 0.08, 0.78, {
          width: 0.84,
        }),
        span('Figure 10: SSIM Scoring Table', 0.3, 0.92, { width: 0.4 }),
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        top: expect.closeTo(0.04, 3),
        height: expect.closeTo(0.878, 3),
      }),
    ]);
  });

  it('keeps tightly spaced narrative content above a diagram outside the figure', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 11,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('3.1. Context Diagram', 0.1, 0.08, { width: 0.3 }),
        span(
          'Context diagrams explain relationships within the system.',
          0.1,
          0.14,
          {
            width: 0.8,
          },
        ),
        span('A context diagram contains the following elements:', 0.1, 0.24, {
          width: 0.75,
        }),
        span('• The innermost ring is under direct control.', 0.14, 0.31, {
          width: 0.72,
        }),
        span('• The outer ring contains the wider environment.', 0.14, 0.37, {
          width: 0.72,
        }),
        span('Wider environment', 0.34, 0.405, { width: 0.3 }),
        span('Target system', 0.39, 0.58, { width: 0.22 }),
        span('Figure 11: Context Diagram', 0.3, 0.86, { width: 0.4 }),
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        top: expect.closeTo(0.393, 3),
        height: expect.closeTo(0.465, 3),
      }),
    ]);
  });

  it('rasterizes a table proposed by an external layout detector', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 12,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [span('Regular body text above the table', 0.25, 0.16, { width: 0.5 })],
      [
        {
          label: 'table',
          confidence: 0.93,
          x: 0.1,
          top: 0.2,
          width: 0.8,
          height: 0.5,
        },
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        source: 'rendered-figure',
        x: expect.closeTo(0.1, 3),
        top: expect.closeTo(0.2, 3),
        width: expect.closeTo(0.8, 3),
        height: expect.closeTo(0.5, 3),
      }),
    ]);
  });

  it('keeps the strongest overlapping Heron picture or table proposal above 0.6', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 18,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [],
      [
        {
          label: 'table',
          confidence: 0.63,
          x: 0.12,
          top: 0.3,
          width: 0.76,
          height: 0.4,
        },
        {
          label: 'picture',
          confidence: 0.62,
          x: 0.02,
          top: 0.29,
          width: 0.96,
          height: 0.42,
        },
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        source: 'rendered-figure',
        x: expect.closeTo(0.12, 3),
        top: expect.closeTo(0.3, 3),
        width: expect.closeTo(0.76, 3),
        height: expect.closeTo(0.4, 3),
      }),
    ]);
  });

  it('rejects a Heron picture proposal that encloses flowing prose', async () => {
    const page = {
      pageNumber: 19,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };
    const spans = [
      span('The encoder is composed of a stack of six identical', 0.16, 0.3, {
        width: 0.65,
      }),
      span(
        'layers with residual connections around each sub-layer',
        0.16,
        0.32,
        {
          width: 0.66,
        },
      ),
      span('followed by layer normalization.', 0.16, 0.34, { width: 0.4 }),
    ];

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      spans,
      [
        {
          label: 'picture',
          confidence: 0.91,
          x: 0.15,
          top: 0.29,
          width: 0.7,
          height: 0.08,
        },
      ],
    );

    expect(images).toEqual([]);
  });

  it('prefers a learned figure proposal over overlapping broad vector geometry', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 20,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      getOperatorList: async () => ({
        fnArray: [OPS.constructPath],
        argsArray: [
          [
            Int32Array.from([20]),
            Float32Array.from([30, 40, 570, 760]),
            Float32Array.from([30, 40, 570, 760]),
          ],
        ],
      }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 20,
        maxTextItemsPerPage: 20,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('Explanatory prose above the diagram.', 0.1, 0.23, {
          width: 0.8,
        }),
        span('Figure 11: Context Map framework', 0.3, 0.83, { width: 0.4 }),
      ],
      [
        {
          label: 'picture',
          confidence: 0.89,
          x: 0.12,
          top: 0.44,
          width: 0.76,
          height: 0.43,
        },
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        source: 'rendered-figure',
        x: expect.closeTo(0.12, 3),
        top: expect.closeTo(0.44, 3),
        width: expect.closeTo(0.76, 3),
        height: expect.closeTo(0.43, 3),
      }),
    ]);
  });

  it('rasterizes a meaningful embedded image as a composed figure region', async () => {
    const image = {
      width: 600,
      height: 800,
      kind: 3,
      data: new Uint8Array(600 * 800 * 4).fill(255),
    };
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      pageNumber: 3,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
      objs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(image),
      },
      getOperatorList: async () => ({
        fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [
          undefined,
          [240, 0, 0, 320, 180, 300],
          ['figure'],
          undefined,
        ],
      }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-figure-3-0',
        source: 'rendered-figure',
        mediaType: 'image/png',
      }),
    ]);
    expect(render).toHaveBeenCalledOnce();
  });

  it('includes a short centered label above an embedded figure', async () => {
    const image = {
      width: 100,
      height: 160,
      kind: 3,
      data: new Uint8Array(100 * 160 * 4).fill(255),
    };
    const page = {
      pageNumber: 4,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      objs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(image),
      },
      getOperatorList: async () => ({
        fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [
          undefined,
          [120, 0, 0, 160, 300, 560],
          ['figure'],
          undefined,
        ],
      }),
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      [
        span('Multi-Head Attention', 0.5, 0.67, {
          width: 0.2,
          height: 0.013,
          fontSize: 10,
        }),
      ],
    );

    expect(images[0]).toMatchObject({
      source: 'rendered-figure',
      top: expect.closeTo(0.662, 3),
    });
  });

  it('keeps a centered display equation as extracted text', async () => {
    const page = {
      pageNumber: 4,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };
    const spans = [
      span('Attention(', 0.35, 0.59, {
        width: 0.08,
        height: 0.013,
        fontSize: 10,
      }),
      span('Q, K, V', 0.43, 0.59, { width: 0.06, fontSize: 10 }),
      span(') = softmax(', 0.49, 0.59, { width: 0.11, fontSize: 10 }),
      span('QK', 0.6, 0.582, { width: 0.03, fontSize: 10 }),
      span('T', 0.63, 0.578, { width: 0.01, fontSize: 7 }),
      span('√d', 0.6, 0.6, { width: 0.03, fontSize: 10 }),
      span('k', 0.63, 0.61, { width: 0.01, fontSize: 7 }),
      span(')V', 0.65, 0.59, { width: 0.03, fontSize: 10 }),
      span('(1)', 0.8, 0.59, { width: 0.02, fontSize: 10 }),
      span('Following prose must remain outside the crop.', 0.17, 0.623, {
        width: 0.65,
      }),
    ];

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      spans,
      [
        {
          label: 'picture',
          confidence: 0.75,
          x: 0.34,
          top: 0.57,
          width: 0.5,
          height: 0.07,
        },
      ],
    );

    expect(images).toEqual([
      expect.objectContaining({
        id: 'pdf-equation-4-0',
        source: 'rendered-equation',
        x: expect.closeTo(0.35, 3),
        width: expect.closeTo(0.47, 3),
      }),
    ]);
  });

  it('captures compact equations and inline radical fractions', async () => {
    const page = {
      pageNumber: 4,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };
    const spans = [
      span('The previous sentence must stay outside the crop.', 0.55, 0.175, {
        width: 0.32,
      }),
      span('we scale the dot products by', 0.55, 0.2, { width: 0.18 }),
      span('1', 0.75, 0.205, { width: 0.01, fontSize: 8 }),
      span('√d', 0.745, 0.208, { width: 0.025, fontSize: 8 }),
      span('k', 0.77, 0.215, { width: 0.008, fontSize: 6 }),
      span('.', 0.79, 0.2, { width: 0.005 }),
      span('weights by', 0.68, 0.4, { width: 0.08 }),
      span('√', 0.77, 0.39, { width: 0.014 }),
      span('d', 0.784, 0.4, { width: 0.009 }),
      span('model', 0.793, 0.406, { width: 0.028, fontSize: 7 }),
      span('.', 0.822, 0.4, { width: 0.004 }),
      span('Then their dot product,', 0.393, 0.7, { width: 0.143 }),
      span('q · k =', 0.54, 0.7, { width: 0.043, fontSize: 9 }),
      span('Σ', 0.586, 0.692, { width: 0.016, fontSize: 9 }),
      span('d', 0.602, 0.699, { width: 0.006, fontSize: 6 }),
      span('k', 0.608, 0.702, { width: 0.006, fontSize: 5 }),
      span('i=1', 0.602, 0.708, { width: 0.02, fontSize: 6 }),
      span('q', 0.625, 0.7, { width: 0.007, fontSize: 9 }),
      span('i', 0.632, 0.705, { width: 0.004, fontSize: 6 }),
      span('k', 0.637, 0.7, { width: 0.008, fontSize: 9 }),
      span('i', 0.645, 0.705, { width: 0.004, fontSize: 6 }),
      span(', has mean 0 and variance dk.', 0.65, 0.7, { width: 0.17 }),
    ];

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 10,
        maxTextItemsPerPage: 10,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      spans,
    );

    expect(images).toEqual([
      expect.objectContaining({
        source: 'rendered-equation',
        x: expect.closeTo(0.54, 3),
        width: expect.closeTo(0.109, 3),
      }),
      expect.objectContaining({
        source: 'rendered-equation',
        x: expect.closeTo(0.745, 3),
        top: expect.closeTo(0.205, 3),
        width: expect.closeTo(0.033, 3),
      }),
      expect.objectContaining({
        source: 'rendered-equation',
        x: expect.closeTo(0.77, 3),
        width: expect.closeTo(0.051, 3),
      }),
    ]);
  });

  it('keeps Transformer-style inline equations inside flowing prose', async () => {
    const page = {
      pageNumber: 4,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    };
    const spans = [
      span('To facilitate these residual connections,', 0.16, 0.59, {
        width: 0.27,
      }),
      span('all sub-layers produce outputs', 0.44, 0.59, { width: 0.2 }),
      span('of dimension dmodel = 512.', 0.65, 0.59, { width: 0.16 }),
      span('model', 0.71, 0.6, { width: 0.04, fontSize: 7 }),
      span('for every layer.', 0.82, 0.59, { width: 0.07 }),
      span('We used length penalty α = 0.6 [38].', 0.16, 0.63, {
        width: 0.32,
      }),
      span('α', 0.35, 0.624, { width: 0.01, fontSize: 7 }),
      span('x =', 0.16, 0.67, { width: 0.56 }),
      span('1', 0.72, 0.662, { width: 0.01, fontSize: 7 }),
      span('2', 0.72, 0.68, { width: 0.01, fontSize: 7 }),
      span('A long prose line contains √d within its text.', 0.16, 0.71, {
        width: 0.6,
      }),
      span('k', 0.4, 0.72, { width: 0.01, fontSize: 7 }),
    ];

    const images = await readImages(
      page as never,
      [1, 0, 0, 1, 0, 0],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 10,
        maxTextItemsPerPage: 10,
        maxImages: 10,
        maxImagePixels: 2_000_000,
        maxTotalImagePixels: 3_000_000,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
          dispose: () => undefined,
        }),
      },
      spans,
    );

    expect(images).toEqual([]);
  });

  it('places a rendered equation inline and removes only its covered spans', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('We compute', 0.12, 0.3, { width: 0.12 }),
            span('Attention(Q,K,V)=softmax(QKᵀ/√dk)V', 0.25, 0.3, {
              width: 0.45,
            }),
            span('simultaneously.', 0.71, 0.3, { width: 0.16 }),
          ],
          links: [],
          images: [
            {
              id: 'pdf-equation-1-0',
              x: 0.245,
              top: 0.285,
              width: 0.46,
              height: 0.04,
              pixelWidth: 552,
              pixelHeight: 64,
              mediaType: 'image/png',
              data: Uint8Array.from([137, 80, 78, 71]),
              source: 'rendered-equation',
            },
          ],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        children: [
          expect.objectContaining({ type: 'text', text: 'We compute' }),
          {
            type: 'image',
            assetId: 'pdf-equation-1-0',
            presentation: 'equation',
            width: 0.46,
          },
          expect.objectContaining({ type: 'text', text: 'simultaneously.' }),
        ],
      }),
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
