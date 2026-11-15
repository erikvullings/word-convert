import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';

import {
  analysePdf,
  createManualFormulaCandidate,
  createFormulaCandidates,
  pdfJsReader,
  type RawPdfDocument,
  type RawPdfStrokeSegment,
  type RawPdfTextSpan,
} from './index.ts';
import {
  countVectorPaths,
  proseSpans,
  collectStrokeSegments,
  readGuardedPage,
  readImages,
  readSpans,
  recognizeFormulaCandidates,
  type GuardedPageContext,
  type PdfExtractionOptions,
  type PdfFigureRasterizer,
} from './pdfjs.ts';
import {
  detectBorderlessTables,
  detectRuledTables,
  DEFAULT_BORDERLESS_TABLE_LIMITS,
  DEFAULT_RULED_TABLE_LIMITS,
} from './tables.ts';

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
  it('resolves fonts in each Form XObject resource scope and restores the parent font', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([600, 800]);
    const font = (word: string) => {
      const mappings = [...word]
        .map(
          (character, index) =>
            `<${(65 + index).toString(16)}> <${character.charCodeAt(0).toString(16).padStart(4, '0')}>`,
        )
        .join('\n');
      const unicode = document.context.register(
        document.context.flateStream(
          `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Test def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
5 beginbfchar
${mappings}
endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`,
        ),
      );
      return document.context.register(
        document.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
          ToUnicode: unicode,
        }),
      );
    };
    const parentFont = font('Outer');
    const childFont = font('Clean');
    const form = document.context.register(
      document.context.flateStream(
        'BT /F1 12 Tf 1 0 0 1 60 600 Tm (ABCDE) Tj ET',
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 600, 800],
          Resources: { Font: { F1: childFont } },
        },
      ),
    );
    const inheritedForm = document.context.register(
      document.context.flateStream('BT 1 0 0 1 60 500 Tm (ABCDE) Tj ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 600, 800],
        Resources: {},
      }),
    );
    page.node.set(
      PDFName.of('Resources'),
      document.context.obj({
        Font: { F1: parentFont },
        XObject: { Form: form, Inherited: inheritedForm },
      }),
    );
    page.node.addContentStream(
      document.context.register(
        document.context.flateStream(
          'BT /F1 12 Tf 1 0 0 1 60 700 Tm (ABCDE) Tj ET /Form Do /Inherited Do BT 1 0 0 1 60 400 Tm (ABCDE) Tj ET',
        ),
      ),
    );
    const raw = await pdfJsReader.readRaw(await document.save(), {});
    expect(raw.pages[0]!.spans.map(({ text }) => text)).toEqual([
      'Outer',
      'Clean',
      'Outer',
      'Outer',
    ]);
  });

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
        return {
          tex: '\\mathrm{M u l t i H e a d}(Q,K,V)',
          diagnostics: { tokens: 4 },
        };
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
      tex: '\\mathrm{M u l t i H e a d}(Q,K,V)',
      model: 'test-model',
      reviewConfidence: 'low',
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

  it('recognizes an image-only manual formula region through the bounded crop path', async () => {
    const candidate = createManualFormulaCandidate(
      {
        id: 'pdf-equation-manual-p1-1000-2000-3000-1000',
        page: 1,
        kind: 'display',
        bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
      },
      [],
    );
    const dispose = vi.fn();
    const recognize = vi.fn(async () => ({
      tex: '\\frac{a}{b}',
      diagnostics: { tokens: 6 },
    }));

    const recognized = await recognizeFormulaCandidates(
      {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      } as never,
      [candidate],
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => new Uint8Array(),
          dispose,
        }),
      },
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 1_000_000,
        maxTotalCropPixels: 1_000_000,
        maxRecognitionTokens: 10,
      },
    );

    expect(recognize).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(recognized[0]).toMatchObject({
      id: candidate.id,
      sources: ['manual'],
      recognition: { tex: '\\frac{a}{b}', model: 'test-model' },
    });
  });

  it('recognizes clearly separated PDF formula rows and joins aligned TeX', async () => {
    const first = span('a = b', 0.25, 0.3, { width: 0.3 });
    const second = span('c = d', 0.25, 0.36, { width: 0.3 });
    const candidate = {
      id: 'multiline',
      page: 1,
      kind: 'display' as const,
      bounds: { x: 0.24, top: 0.29, width: 0.32, height: 0.1 },
      spanIds: [first.id, second.id],
      features: {
        mathFontRatio: 1,
        operatorRatio: 0.2,
        greekRatio: 0,
        symbolRatio: 0,
        singleLetterTokenRatio: 0.5,
        dictionaryLikeWordRatio: 0,
        superscriptCount: 0,
        subscriptCount: 0,
        baselineVariance: 0.001,
        fontSizeVariance: 0,
        centered: true,
        isolated: true,
        equationNumberAtRight: false,
        multilineStructure: false,
        score: 4,
        confidence: 'high' as const,
      },
      score: 4,
      confidence: 'high' as const,
      sources: ['heron' as const],
      requiresRecognition: true,
    };
    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ tex: 'a = b', diagnostics: { tokens: 3 } })
      .mockResolvedValueOnce({ tex: 'c = d', diagnostics: { tokens: 3 } });

    const recognized = await recognizeFormulaCandidates(
      {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      } as never,
      [candidate],
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => new Uint8Array(),
          dispose() {},
        }),
      },
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 1_000_000,
        maxTotalCropPixels: 2_000_000,
        maxRecognitionTokens: 10,
      },
      undefined,
      undefined,
      undefined,
      [first, second],
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognized[0]?.recognition?.tex).toBe(
      '\\begin{aligned}a = b \\\\ c = d\\end{aligned}',
    );
  });

  it('keeps narrow script spans in one formula recognition crop', async () => {
    const base = span('x = y', 0.25, 0.3, { width: 0.3 });
    const script = span('2', 0.52, 0.285, { width: 0.01, height: 0.01 });
    const candidate = {
      id: 'scripted',
      page: 1,
      kind: 'display' as const,
      bounds: { x: 0.24, top: 0.28, width: 0.32, height: 0.05 },
      spanIds: [base.id, script.id],
      features: {
        mathFontRatio: 1,
        operatorRatio: 0.2,
        greekRatio: 0,
        symbolRatio: 0,
        singleLetterTokenRatio: 0.5,
        dictionaryLikeWordRatio: 0,
        superscriptCount: 1,
        subscriptCount: 0,
        baselineVariance: 0.001,
        fontSizeVariance: 0,
        centered: true,
        isolated: true,
        equationNumberAtRight: false,
        multilineStructure: true,
        score: 4,
        confidence: 'high' as const,
      },
      score: 4,
      confidence: 'high' as const,
      sources: ['geometry' as const],
      requiresRecognition: true,
    };
    const recognize = vi.fn(async () => ({
      tex: 'x = y^2',
      diagnostics: { tokens: 5 },
    }));

    await recognizeFormulaCandidates(
      {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      } as never,
      [candidate],
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => new Uint8Array(),
          dispose() {},
        }),
      },
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 1_000_000,
        maxTotalCropPixels: 2_000_000,
        maxRecognitionTokens: 10,
      },
      undefined,
      undefined,
      undefined,
      [base, script],
    );

    expect(recognize).toHaveBeenCalledOnce();
  });

  it('uses PDF identifiers and keeps equation numbers outside OCR crops', async () => {
    const formula = span(
      'lrate = d model min step num warmup steps',
      0.3,
      0.4,
      { width: 0.4 },
    );
    const number = span('(3)', 0.82, 0.4, { width: 0.04 });
    const candidate = {
      id: 'numbered',
      page: 1,
      kind: 'display' as const,
      bounds: { x: 0.28, top: 0.38, width: 0.58, height: 0.06 },
      spanIds: [formula.id],
      features: {
        mathFontRatio: 1,
        operatorRatio: 0.2,
        greekRatio: 0,
        symbolRatio: 0,
        singleLetterTokenRatio: 0.5,
        dictionaryLikeWordRatio: 0,
        superscriptCount: 0,
        subscriptCount: 0,
        baselineVariance: 0,
        fontSizeVariance: 0,
        centered: true,
        isolated: true,
        equationNumberAtRight: true,
        multilineStructure: false,
        score: 4,
        confidence: 'high' as const,
      },
      score: 4,
      confidence: 'high' as const,
      sources: ['heron' as const],
      requiresRecognition: true,
    };
    const widths: number[] = [];
    const recognize = vi.fn(async (image: { width: number }) => {
      widths.push(image.width);
      return {
        tex: 'frace=d_{\\text{nodel}}^{-0.5}\\cdot\\min(step\\_num,warmup\\_steps)',
        diagnostics: { tokens: 12 },
      };
    });

    const recognized = await recognizeFormulaCandidates(
      {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      } as never,
      [candidate],
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: (width, height) => ({
          canvas: { width, height },
          readRgba: () => new Uint8ClampedArray(width * height * 4).fill(255),
          encodePng: async () => new Uint8Array(),
          dispose() {},
        }),
      },
      { implementation: 'test-model', recognize },
      {
        maxCandidatesPerPage: 10,
        maxCandidatesTotal: 10,
        maxCropPixels: 1_000_000,
        maxTotalCropPixels: 2_000_000,
        maxRecognitionTokens: 50,
      },
      undefined,
      undefined,
      undefined,
      [formula, number],
    );

    expect(widths[0]).toBeLessThan(600 * 3 * candidate.bounds.width);
    expect(recognized[0]?.recognition?.tex).toBe(
      'lrate=d_{\\text{model}}^{-0.5}\\cdot\\min(step\\_num,warmup\\_steps)\\tag{3}',
    );
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
                model: 'texteller-onnx-q4',
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

  it('places recognized formulas whose source rows are detached math fragments', async () => {
    const before = span('Before the equation.', 0.1, 0.2, { width: 0.4 });
    const numerator = span('QK', 0.4, 0.3, {
      width: 0.04,
      fontSize: 7,
    });
    const denominator = span('dk', 0.4, 0.32, {
      width: 0.04,
      fontSize: 7,
    });
    const after = span('After the equation.', 0.1, 0.4, { width: 0.4 });
    const detected = createFormulaCandidates({
      page: 1,
      spans: [span('QK = dk', 0.35, 0.29, { width: 0.2 })],
    })[0]!;
    const candidate = {
      ...detected,
      bounds: { x: 0.34, top: 0.28, width: 0.22, height: 0.07 },
      spanIds: [numerator.id, denominator.id],
      recognition: {
        tex: '\\frac{QK}{d_k}',
        model: 'texteller-onnx-q4',
        reviewConfidence: 'high' as const,
      },
      requiresRecognition: true,
    };
    delete candidate.tex;

    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [before, numerator, denominator, after],
          links: [],
          images: [],
          formulaCandidates: [candidate],
        },
      ]),
      { conversionDate: '2026-09-03' },
    );

    expect(result.model.equations[candidate.id]?.tex).toBe('\\frac{QK}{d_k}');
    expect(result.model.blocks).toEqual([
      expect.objectContaining({ type: 'paragraph' }),
      { type: 'equationBlock', equationId: candidate.id },
      expect.objectContaining({ type: 'paragraph' }),
    ]);
  });

  it('prefers requested TexTeller recognition over stale reconstructed TeX', async () => {
    const formula = span('QK = dk', 0.35, 0.3, { width: 0.2 });
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
              requiresRecognition: true,
              recognition: {
                tex: '\\frac{QK}{d_k}',
                model: 'texteller-onnx-q4',
                reviewConfidence: 'high',
              },
            },
          ],
        },
      ]),
      { conversionDate: '2026-09-03' },
    );

    expect(result.model.equations[detected.id]?.tex).toBe('\\frac{QK}{d_k}');
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

  it('reconstructs OCR body paragraphs across font-size drift and drop-cap indentation', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        imageBacked: true,
        spans: [
          span('e Tao Te Tsjing is een hoeksteen van Chinese', 0.17, 0.45, {
            width: 0.75,
            height: 0.017,
            fontSize: 8.82,
          }),
          span('beschaving. De traditionele opvatting is dat het', 0.17, 0.48, {
            width: 0.75,
            height: 0.017,
            fontSize: 9.18,
          }),
          span(
            'geschreven is door Lao-tse, een oudere tijdgenoot van',
            0.08,
            0.51,
            {
              width: 0.84,
              height: 0.017,
              fontSize: 9.36,
            },
          ),
          span('Confucius. Hoewel het al zo lang geleden is ge-', 0.08, 0.54, {
            width: 0.84,
            height: 0.017,
            fontSize: 9.36,
          }),
          span('schreven, blijft het belangrijke leesstof.', 0.08, 0.576, {
            width: 0.7,
            height: 0.011,
            fontSize: 5.76,
          }),
          span('Een nieuwe alinea begint hier', 0.13, 0.62, {
            width: 0.79,
            height: 0.017,
            fontSize: 9.36,
          }),
          span('en loopt door op de volgende regel.', 0.08, 0.65, {
            width: 0.84,
            height: 0.017,
            fontSize: 9.18,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, { conversionDate: '2026-09-06' });
    const paragraphs = result.model.blocks
      .filter((block) => block.type === 'paragraph')
      .map((block) =>
        block.children
          .map((child) => (child.type === 'text' ? child.text : ''))
          .join(''),
      );

    expect(paragraphs).toEqual([
      'e Tao Te Tsjing is een hoeksteen van Chinese beschaving. De traditionele opvatting is dat het geschreven is door Lao-tse, een oudere tijdgenoot van Confucius. Hoewel het al zo lang geleden is geschreven, blijft het belangrijke leesstof.',
      'Een nieuwe alinea begint hier en loopt door op de volgende regel.',
    ]);
    expect(
      result.model.blocks
        .filter((block) => block.type === 'paragraph')
        .flatMap((block) => block.children)
        .filter((child) => child.type === 'text')
        .flatMap((child) => child.marks ?? []),
    ).not.toContainEqual(
      expect.objectContaining({ type: expect.stringMatching(/script$/) }),
    );
  });

  it('does not infer script marks from image-backed OCR glyph drift', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        imageBacked: true,
        spans: [
          span('Tao', 0.1, 0.3, {
            width: 0.12,
            height: 0.02,
            fontSize: 10,
            baseline: 0.318,
          }),
          span('Te Tsjing', 0.23, 0.292, {
            width: 0.3,
            height: 0.012,
            fontSize: 5.5,
            baseline: 0.302,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, { conversionDate: '2026-09-06' });
    const paragraph = result.model.blocks.find(
      (block) => block.type === 'paragraph',
    );

    expect(paragraph).toMatchObject({
      children: [
        { type: 'text', text: 'Tao' },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'Te Tsjing' },
      ],
    });
  });

  it('distinguishes indented OCR paragraph starts from wrapped sentences', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        imageBacked: true,
        spans: [
          span('De eerste zin loopt door tot aan de', 0.08, 0.2, {
            width: 0.84,
            height: 0.017,
          }),
          span('volgende regel. Daarna volgt nog tekst.', 0.08, 0.23, {
            width: 0.745,
            height: 0.017,
          }),
          span('Een nieuwe alinea springt iets in en', 0.125, 0.26, {
            width: 0.7,
            height: 0.017,
          }),
          span('loopt vervolgens door aan de linkermarge.', 0.08, 0.29, {
            width: 0.745,
            height: 0.017,
          }),
          span('Deze regel eindigt nog niet en', 0.08, 0.32, {
            width: 0.84,
            height: 0.017,
          }),
          span('lijkt door OCR ingesprongen.', 0.16, 0.35, {
            width: 0.76,
            height: 0.017,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, { conversionDate: '2026-09-06' });
    const paragraphs = result.model.blocks
      .filter((block) => block.type === 'paragraph')
      .map((block) =>
        block.children
          .map((child) => (child.type === 'text' ? child.text : ''))
          .join(''),
      );

    expect(paragraphs).toEqual([
      'De eerste zin loopt door tot aan de volgende regel. Daarna volgt nog tekst.',
      'Een nieuwe alinea springt iets in en loopt vervolgens door aan de linkermarge. Deze regel eindigt nog niet en lijkt door OCR ingesprongen.',
    ]);
  });

  it('preserves OCR verse lines and stanza gaps without splitting prose lines', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        imageBacked: true,
        spans: [
          span('Er naar kijkend en het niet ziend,', 0.17, 0.2, {
            width: 0.55,
            height: 0.017,
          }),
          span('noemen wij het onzichtbaar;', 0.17, 0.23, {
            width: 0.44,
            height: 0.017,
          }),
          span('er naar luisterend en het niet horend,', 0.17, 0.26, {
            width: 0.58,
            height: 0.017,
          }),
          span('noemen wij het onhoorbaar.', 0.17, 0.29, {
            width: 0.43,
            height: 0.017,
          }),
          span('Deze drie aspecten van het ene', 0.17, 0.35, {
            width: 0.47,
            height: 0.017,
          }),
          span('zijn niet te vatten,', 0.17, 0.38, {
            width: 0.3,
            height: 0.017,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, { conversionDate: '2026-09-06' });
    const paragraphs = result.model.blocks.filter(
      (block) => block.type === 'paragraph',
    );

    expect(paragraphs).toEqual([
      expect.objectContaining({
        children: [
          { type: 'text', text: 'Er naar kijkend en het niet ziend,' },
          { type: 'lineBreak' },
          { type: 'text', text: 'noemen wij het onzichtbaar;' },
          { type: 'lineBreak' },
          { type: 'text', text: 'er naar luisterend en het niet horend,' },
          { type: 'lineBreak' },
          { type: 'text', text: 'noemen wij het onhoorbaar.' },
        ],
      }),
      expect.objectContaining({
        children: [
          { type: 'text', text: 'Deze drie aspecten van het ene' },
          { type: 'lineBreak' },
          { type: 'text', text: 'zijn niet te vatten,' },
        ],
      }),
    ]);
  });

  it('rejects noisy inferred headings on image-backed OCR pages while preserving explicit mappings', async () => {
    const raw = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        imageBacked: true,
        spans: [
          span('Voorwoord', 0.36, 0.16, {
            width: 0.28,
            fontSize: 15,
          }),
          span('ukahses', 0.38, 0.23, {
            width: 0.24,
            fontSize: 15,
          }),
          span('| Abee rearpane', 0.27, 0.3, {
            width: 0.46,
            fontSize: 25,
          }),
          span('Y', 0.48, 0.4, { width: 0.04, fontSize: 37 }),
          span('1068 EL Amsterdam', 0.35, 0.45, {
            width: 0.3,
            fontSize: 11,
          }),
          span('B een wandelende voet die gaan betekent. Samen', 0.08, 0.5, {
            width: 0.84,
            fontSize: 13,
          }),
          span('Dit is gewone tekst in de hoofdtekst.', 0.08, 0.6, {
            width: 0.7,
            fontSize: 9,
          }),
          span('Nog een gewone regel tekst.', 0.08, 0.63, {
            width: 0.7,
            fontSize: 9,
          }),
          span('Ook deze regel is gewone tekst.', 0.08, 0.66, {
            width: 0.7,
            fontSize: 9,
          }),
          span('De hoofdtekst bepaalt de basisgrootte.', 0.08, 0.69, {
            width: 0.7,
            fontSize: 9,
          }),
          span('Dit voorkomt een vertekende mediaan.', 0.08, 0.72, {
            width: 0.7,
            fontSize: 9,
          }),
        ],
        links: [],
        images: [],
      },
    ]);

    const result = await analysePdf(raw, { conversionDate: '2026-09-06' });
    const headings = result.model.blocks
      .filter((block) => block.type === 'heading')
      .map((block) =>
        block.children
          .map((child) => (child.type === 'text' ? child.text : ''))
          .join(''),
      );

    expect(headings).toEqual(['Voorwoord']);

    const explicitlyMapped = await analysePdf(raw, {
      conversionDate: '2026-09-06',
      styleMappings: { 'pdf-body-25-regular-roman': 'heading2' },
    });
    expect(
      explicitlyMapped.model.blocks
        .filter((block) => block.type === 'heading')
        .map((block) =>
          block.children
            .map((child) => (child.type === 'text' ? child.text : ''))
            .join(''),
        ),
    ).toContain('| Abee rearpane');
  });

  it('omits scattered OCR fragments from image-backed illustration pages', async () => {
    const fragments = Array.from({ length: 20 }, (_, index) =>
      span(index % 2 ? 'ae' : '—', (index % 5) * 0.18, 0.1 + index * 0.035, {
        width: 0.03,
        height: index < 4 ? 0.006 : 0.012,
        fontSize: index < 4 ? 4 : 9,
      }),
    );
    const catalog = Array.from({ length: 20 }, (_, index) =>
      span(
        `Published title ${index}`,
        0.08 + (index % 2) * 0.42,
        0.1 + index * 0.03,
        {
          width: 0.18,
          height: index < 2 ? 0.006 : 0.012,
          fontSize: index < 2 ? 4 : 9,
        },
      ),
    );
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          imageBacked: true,
          spans: fragments,
          links: [],
          images: [],
        },
        {
          number: 2,
          width: 600,
          height: 800,
          rotation: 0,
          imageBacked: true,
          spans: catalog,
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-09-06' },
    );

    expect(JSON.stringify(result.model.blocks)).toContain('Published title');
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: 'pdf-noisy-ocr-omitted',
        details: { pages: 1 },
      }),
    );
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
    it('promotes repeated unstyled chapter openers with confident provenance', async () => {
      const result = await pdfJsReader.read(
        await fixture('unstyled-chapters.pdf'),
        { conversionDate: '2026-08-29' },
      );
      const headings = result.model.blocks.filter(
        (block): block is Extract<typeof block, { type: 'heading' }> =>
          block.type === 'heading' && block.level === 2,
      );

      expect(
        headings.map((heading) =>
          heading.children
            .map((node) => (node.type === 'text' ? node.text : ''))
            .join(''),
        ),
      ).toEqual(['Chapter One', 'Chapter Two']);
      expect(headings[0]?.provenance).toMatchObject({
        source: 'pdf-chapter-detection',
        method: 'inferred',
        confidence: 'high',
      });
      expect(result.model.warnings).toContainEqual(
        expect.objectContaining({
          code: 'pdf-chapters-promoted',
          details: { headings: 2 },
        }),
      );
      expect(result.model.warnings).toContainEqual(
        expect.objectContaining({
          code: 'chapters-detected',
          details: { chapters: 2, splitLevel: 2 },
        }),
      );
    });

    it('routes low-confidence chapter candidates to their style mapping', async () => {
      const result = await pdfJsReader.read(
        await fixture('unstyled-chapters.pdf'),
        {
          conversionDate: '2026-08-29',
          chapterDetection: {
            mode: 'automatic',
            headingLevels: [2],
            keywords: ['chapter one'],
          },
        },
      );
      const proposal = result.model.warnings.find(
        ({ code }) => code === 'pdf-chapter-detection-proposal',
      );

      expect(proposal?.details?.styleId).toBeTruthy();
      expect(proposal?.message).toContain('Chapter One');
      expect(
        result.model.blocks.some(
          (block) =>
            block.type === 'heading' &&
            block.provenance?.source === 'pdf-chapter-detection',
        ),
      ).toBe(false);
    });

    it('does not promote body lines mapped explicitly by the user', async () => {
      const bytes = await fixture('unstyled-chapters.pdf');
      const firstPass = await pdfJsReader.read(bytes, {
        conversionDate: '2026-08-29',
      });
      const bodyStyleId = firstPass.model.styles.find(
        ({ formatting }) => formatting.fontSizePt === 12,
      )?.id;
      if (!bodyStyleId) throw new Error('Missing fixture body style');
      const result = await pdfJsReader.read(bytes, {
        conversionDate: '2026-08-29',
        styleMappings: { [bodyStyleId]: 'body' },
      });

      expect(
        result.model.blocks.filter(
          (block) =>
            block.type === 'heading' &&
            block.provenance?.source === 'pdf-chapter-detection',
        ),
      ).toHaveLength(0);
    });

    it('merges a split same-style title while preserving the original heading block', async () => {
      const result = await pdfJsReader.read(
        await fixture('split-heading-title.pdf'),
        { conversionDate: '2026-08-29' },
      );
      const headings = result.model.blocks.filter(
        (block): block is Extract<typeof block, { type: 'heading' }> =>
          block.type === 'heading',
      );
      const title = headings.find((heading) =>
        heading.children.some(
          (node) => node.type === 'text' && node.text.includes('THE'),
        ),
      );

      expect(headings).toHaveLength(1);
      expect(
        title?.children
          .map((node) => (node.type === 'text' ? node.text : ''))
          .join(''),
      ).toBe('THE LONG WAIT');
      expect(result.model.warnings).toContainEqual(
        expect.objectContaining({ code: 'heading-runs-merged' }),
      );
    });

    it('preserves Part and Chapter nesting and reports a one-file book with no chapters', async () => {
      const nested = await pdfJsReader.read(await fixture('part-nesting.pdf'), {
        conversionDate: '2026-08-29',
      });
      const nestedHeadings = nested.model.blocks.filter(
        (block): block is Extract<typeof block, { type: 'heading' }> =>
          block.type === 'heading',
      );
      const empty = await pdfJsReader.read(
        await fixture('two-column-article.pdf'),
        {
          conversionDate: '2026-08-29',
          chapterDetection: {
            mode: 'off',
            headingLevels: [1, 2],
            keywords: [],
          },
        },
      );

      expect(
        nestedHeadings.map((heading) => [
          heading.level,
          heading.children
            .map((node) => (node.type === 'text' ? node.text : ''))
            .join(''),
        ]),
      ).toEqual([
        [1, 'Part One'],
        [2, 'Chapter One'],
        [1, 'Part Two'],
        [2, 'Chapter Two'],
      ]);
      expect(empty.model.warnings).toContainEqual(
        expect.objectContaining({
          code: 'chapters-detected',
          details: { chapters: 1, splitLevel: 2 },
        }),
      );
      expect(empty.model.warnings).not.toContainEqual(
        expect.objectContaining({ code: 'pdf-chapters-promoted' }),
      );
    });

    it('rejects malformed chapter detection options as structured input errors', async () => {
      await expect(
        analysePdf(rawDocument([]), {
          conversionDate: '2026-08-29',
          chapterDetection: {
            mode: 'automatic',
            headingLevels: [2],
            keywords: ['chapter'],
            unknown: true,
          } as never,
        }),
      ).rejects.toMatchObject({
        code: 'invalid-input',
        phase: 'analyse',
        details: { path: 'unknown', issueCode: 'unknown' },
      });
    });

    it('keeps furniture candidate ids stable for the book fixture', async () => {
      const bytes = await fixture('one-column-book.pdf');
      const options = {
        conversionDate: '2026-08-29',
        filename: 'fixture.pdf',
      };
      const first = await pdfJsReader.read(bytes, options);
      const second = await pdfJsReader.read(bytes, options);

      expect(first.analysis.candidates.map(({ id }) => id)).toEqual(
        second.analysis.candidates.map(({ id }) => id),
      );
      expect(first.analysis.candidates.length).toBeGreaterThan(0);
    });

    it('skips PDF image extraction and counts omitted placements when requested', async () => {
      const raw = await pdfJsReader.readRaw(await fixture('scanned-page.pdf'), {
        conversionDate: '2026-08-29',
        extractImages: false,
      });

      expect(raw.pages.every(({ images }) => images.length === 0)).toBe(true);
      expect(
        raw.pages.reduce(
          (total, page) => total + (page.omittedImageCount ?? 0),
          0,
        ),
      ).toBeGreaterThan(0);
    });

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
      const [book, tagged, scannedRaw, scanned] = await Promise.all([
        pdfJsReader.readRaw(await fixture('one-column-book.pdf'), {
          conversionDate: '2026-08-29',
        }),
        pdfJsReader.readRaw(await fixture('tagged-article.pdf'), {
          conversionDate: '2026-08-29',
        }),
        pdfJsReader.readRaw(await fixture('scanned-page.pdf'), {
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
        imageBacked: scannedRaw.pages[0]?.imageBacked,
        images: Object.keys(scanned.model.assets),
        imageBackedPages: scanned.analysis.imageBackedPages,
        warning: scanned.model.warnings.map(({ code }) => code),
      }).toMatchObject({
        link: 'https://example.com/',
        tagged: 'Root',
        markedContent: expect.any(String),
        imageBacked: true,
        images: ['pdf-image-1-0'],
        imageBackedPages: [1],
        warning: [
          'pdf-ocr-not-supported',
          'pdf-line-reflow-summary',
          'chapters-detected',
        ],
      });
    });

    it('detects generated formula layouts without classifying deliberate false positives', async () => {
      const [formulaLayouts, falsePositives] = await Promise.all([
        pdfJsReader.read(await fixture('formula-layouts.pdf'), {
          conversionDate: '2026-09-02',
        }),
        pdfJsReader.read(await fixture('formula-false-positives.pdf'), {
          conversionDate: '2026-09-02',
        }),
      ]);

      const detectedTex = Object.values(formulaLayouts.model.equations).map(
        ({ tex }) => tex,
      );
      expect(detectedTex.some((tex) => /x.*y.*z/.test(tex))).toBe(true);
      expect(detectedTex).not.toContain('i=1');
      expect(falsePositives.analysis.formulaCandidates ?? []).toEqual([]);
      expect(Object.keys(falsePositives.model.equations)).toEqual([]);
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

    it('uses the browser task scheduler for responsive analysis checkpoints', async () => {
      const yieldTask = vi.fn(async () => undefined);
      vi.stubGlobal('scheduler', { yield: yieldTask });
      try {
        await analysePdf(
          rawDocument([
            {
              number: 1,
              width: 600,
              height: 800,
              rotation: 0,
              spans: [span('Body text', 0.1, 0.2)],
              links: [],
              images: [],
            },
          ]),
          { conversionDate: '2026-09-08' },
        );
      } finally {
        vi.unstubAllGlobals();
      }

      expect(yieldTask).toHaveBeenCalled();
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
    expect(first).toMatchObject({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'dimension d' },
        { type: 'text', text: 'model', marks: [{ type: 'subscript' }] },
        { type: 'text', text: '= 512.' },
      ],
    });
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
            span('Wrapped first line', 0.1, 0.2, { width: 0.78 }),
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

  it('preserves short adjacent body lines as semantic soft breaks', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('The quiet river', 0.1, 0.2, { width: 0.24 }),
            span('moves under moonlight', 0.1, 0.225, { width: 0.31 }),
            span('and carries us home.', 0.1, 0.25, { width: 0.3 }),
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
          { text: 'The quiet river' },
          { type: 'lineBreak' },
          { text: 'moves under moonlight' },
          { type: 'lineBreak' },
          { text: 'and carries us home.' },
        ],
      },
    ]);
  });

  it('preserves short adjacent lines in a right column as soft breaks', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Left column prose.', 0.08, 0.1, { width: 0.32 }),
            span('A short verse line', 0.55, 0.1, { width: 0.15 }),
            span('another short line', 0.55, 0.125, { width: 0.18 }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );
    const verse = result.model.blocks.find(
      (block) =>
        block.type === 'paragraph' &&
        block.children.some(
          (child) =>
            child.type === 'text' && child.text === 'A short verse line',
        ),
    );

    expect(verse).toMatchObject({
      type: 'paragraph',
      children: [
        { text: 'A short verse line' },
        { type: 'lineBreak' },
        { text: 'another short line' },
      ],
    });
  });

  it('merges wrapped body lines that reach the text column edge', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'A full prose line reaches the right edge of the page',
              0.1,
              0.2,
              {
                width: 0.79,
              },
            ),
            span('and continues on the next source line.', 0.1, 0.225, {
              width: 0.55,
            }),
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
          { text: 'A full prose line reaches the right edge of the page' },
          { text: ' ' },
          { text: 'and continues on the next source line.' },
        ],
      },
    ]);
  });

  it('merges wrapped body lines at an observed single-column margin', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'This is a normal paragraph line that wraps near the margin',
              0.15,
              0.2,
              { width: 0.63 },
            ),
            span(
              'but does not reach the absolute page-edge threshold',
              0.15,
              0.225,
              { width: 0.6 },
            ),
            span('and ends on a shorter final line.', 0.15, 0.25, {
              width: 0.45,
            }),
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
            text: 'This is a normal paragraph line that wraps near the margin',
          },
          { text: ' ' },
          { text: 'but does not reach the absolute page-edge threshold' },
          { text: ' ' },
          { text: 'and ends on a shorter final line.' },
        ],
      },
    ]);
  });

  it('merges a lone wide prose line with its short continuation', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span(
              'A normal sentence reaches the margin and continues',
              0.12,
              0.2,
              { width: 0.6 },
            ),
            span('on one final short line.', 0.12, 0.225, { width: 0.3 }),
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
          { text: 'A normal sentence reaches the margin and continues' },
          { text: ' ' },
          { text: 'on one final short line.' },
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

  it.each(['\\', '**'])(
    'drops isolated OCR punctuation %s immediately before a page break',
    async (punctuation) => {
      const result = await analysePdf(
        rawDocument([
          {
            number: 1,
            width: 600,
            height: 800,
            rotation: 0,
            spans: [
              span('Last paragraph.', 0.1, 0.7, { width: 0.5 }),
              span(punctuation, 0.02, 0.82, { width: 0.01 }),
            ],
            links: [],
            images: [],
          },
          {
            number: 2,
            width: 600,
            height: 800,
            rotation: 0,
            spans: [span('Next paragraph.', 0.1, 0.1, { width: 0.5 })],
            links: [],
            images: [],
          },
        ]),
        { conversionDate: '2026-08-29' },
      );

      expect(result.model.blocks).toMatchObject([
        { type: 'paragraph', children: [{ text: 'Last paragraph.' }] },
        { type: 'pageBreak' },
        { type: 'paragraph', children: [{ text: 'Next paragraph.' }] },
      ]);
    },
  );

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

  it('does not expose or resolve a full-page scan backdrop as an image', async () => {
    const getImage = vi.fn();
    const operators = {
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [undefined, [100, 0, 0, 100, 0, 0], ['scan'], undefined],
    };
    const getOperatorList = vi.fn().mockResolvedValue(operators);
    const onPageBackdrop = vi.fn();
    const page = {
      pageNumber: 1,
      getViewport: () => ({ width: 100, height: 100 }),
      objs: { get: getImage },
      getOperatorList,
    };

    const images = await readImages(
      page as never,
      [1, 0, 0, -1, 0, 100],
      {
        maxInputBytes: 1,
        maxPages: 1,
        maxTextItems: 1,
        maxTextItemsPerPage: 1,
        maxImages: 1,
        maxImagePixels: 1,
        maxTotalImagePixels: 1,
      },
      undefined,
      undefined,
      {
        CanvasFactory: class {},
        FilterFactory: class {},
        createSurface: vi.fn(),
      },
      [],
      [],
      { operators: operators as never, onPageBackdrop },
    );

    expect(images).toEqual([]);
    expect(onPageBackdrop).toHaveBeenCalledOnce();
    expect(getOperatorList).not.toHaveBeenCalled();
    expect(getImage).not.toHaveBeenCalled();
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
    expect(result.analysis.formulaImageRegions).toEqual([
      {
        id: 'pdf-equation-1-0',
        page: 1,
        bounds: { x: 0.245, top: 0.285, width: 0.46, height: 0.04 },
      },
    ]);
  });

  it('replaces a promoted equation image with its recognized formula', async () => {
    const formula = span('x = √y', 0.25, 0.3, { width: 0.3 });
    const region = {
      id: 'pdf-equation-1-0',
      page: 1,
      bounds: { x: 0.245, top: 0.285, width: 0.31, height: 0.04 },
      kind: 'display' as const,
      forceRecognition: true,
    };
    const candidate = {
      ...createManualFormulaCandidate(region, [formula]),
      recognition: {
        tex: 'x = \\sqrt{y}',
        model: 'texteller-onnx-q4',
        reviewConfidence: 'high' as const,
      },
    };
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [formula],
          links: [],
          images: [
            {
              id: region.id,
              ...region.bounds,
              pixelWidth: 372,
              pixelHeight: 64,
              mediaType: 'image/png',
              data: Uint8Array.from([137, 80, 78, 71]),
              source: 'rendered-equation',
            },
          ],
          formulaCandidates: [candidate],
        },
      ]),
      {
        conversionDate: '2026-09-03',
        formulaDecisions: {
          [region.id]: { equationId: region.id, decision: 'formula' },
        },
      },
    );

    expect(result.model.equations[region.id]?.tex).toBe('x = \\sqrt{y}');
    expect(JSON.stringify(result.model.blocks)).not.toContain(
      `"assetId":"${region.id}"`,
    );
    expect(result.analysis.formulaImageRegions).toEqual([]);
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

describe('dense and slow PDF page guard', () => {
  const testLimits = {
    maxInputBytes: 1_000_000,
    maxPages: 10,
    maxTextItems: 1_000,
    maxTextItemsPerPage: 1_000,
    maxImages: 10,
    maxImagePixels: 1_000_000,
    maxTotalImagePixels: 1_000_000,
    denseVectorPathsPerPage: 3,
    pageTimeoutMs: 0,
  };

  function textItem(str: string, x: number, y: number, size: number) {
    return {
      str,
      dir: 'ltr',
      transform: [size, 0, 0, size, x, y],
      width: str.length * size * 0.5,
      height: size,
      fontName: 'f1',
      hasEOL: false,
    };
  }

  function densePage(overrides: Record<string, unknown> = {}) {
    return {
      pageNumber: 1,
      getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({
        width: 100 * scale,
        height: 200 * scale,
        rotation: 0,
        transform: [scale, 0, 0, -scale, 0, 200 * scale],
      }),
      getTextContent: async () => ({
        items: [
          textItem('Dense heading', 10, 160, 16),
          textItem('Body prose starts here and', 10, 60, 6),
          textItem('continues on the next line.', 10, 52, 6),
          textItem('Waarderen', 60, 120, 6),
        ],
        styles: { f1: { fontFamily: 'Arial', ascent: 0.8, descent: -0.2 } },
        lang: null,
      }),
      getAnnotations: async () => [],
      getStructTree: async () => null,
      objs: { get: vi.fn() },
      commonObjs: { get: vi.fn() },
      getOperatorList: async () => ({
        fnArray: [OPS.constructPath, OPS.constructPath, OPS.constructPath],
        argsArray: [
          [20, [], Float32Array.from([10, 90, 50, 130])],
          [20, [], Float32Array.from([40, 80, 90, 120])],
          [20, [], Float32Array.from([20, 70, 60, 110])],
        ],
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      ...overrides,
    };
  }

  function rasterizer(dispose = vi.fn()): PdfFigureRasterizer {
    return {
      CanvasFactory: class {},
      FilterFactory: class {
        destroy(): void {}
      },
      createSurface: (width, height) => ({
        canvas: { width, height },
        encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
        dispose,
      }),
    };
  }

  function context(
    options: Partial<PdfExtractionOptions> = {},
    densePageMode?: GuardedPageContext['densePageMode'],
  ): GuardedPageContext {
    return {
      options: {
        figureRasterizer: rasterizer(),
        ...options,
        limits: { ...testLimits, ...options.limits },
      },
      imageBudget: { images: 0, pixels: 0 },
      formulaBudget: { candidates: 0, cropPixels: 0, recognized: 0 },
      includeImages: true,
      densePageMode,
      guard: { timedOut: false },
    };
  }

  it('asks how to convert a dense page and keeps its prose beside the page image', async () => {
    const resolveDensePageMode = vi.fn(async () => 'image-and-prose' as const);
    const dispose = vi.fn();
    const guarded = context({
      resolveDensePageMode,
      figureRasterizer: rasterizer(dispose),
    });

    const result = await readGuardedPage(densePage() as never, 1, guarded);

    expect(resolveDensePageMode).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      vectorPaths: 3,
    });
    expect(result.denseMode).toBe('image-and-prose');
    expect(result.page).toMatchObject({
      dense: true,
      fallback: { reason: 'dense', mode: 'image-and-prose' },
      images: [
        {
          id: 'pdf-page-1',
          source: 'rendered-page',
          pixelWidth: 200,
          pixelHeight: 400,
          x: 0,
          top: 0,
          width: 1,
          height: 1,
        },
      ],
    });
    expect(result.page.images[0]!.placementTop).toBeCloseTo(0.35, 2);
    const text = result.page.spans.map(({ text }) => text);
    expect(text).toContain('Dense heading');
    expect(text).toContain('Body prose starts here and');
    expect(text).not.toContain('Waarderen');
    expect(guarded.imageBudget).toEqual({ images: 1, pixels: 80_000 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('applies a known dense-page choice without asking and bounds the page raster', async () => {
    const resolveDensePageMode = vi.fn();
    const result = await readGuardedPage(
      densePage() as never,
      1,
      context(
        {
          resolveDensePageMode,
          limits: { ...testLimits, maxImagePixels: 5_000 },
        },
        'image-only',
      ),
    );

    expect(resolveDensePageMode).not.toHaveBeenCalled();
    expect(result.page.spans).toEqual([]);
    expect(result.page.images[0]).toMatchObject({
      pixelWidth: 50,
      pixelHeight: 100,
    });
  });

  it('does not flag pages below the dense threshold', async () => {
    const resolveDensePageMode = vi.fn();
    const result = await readGuardedPage(
      densePage() as never,
      1,
      context({
        resolveDensePageMode,
        limits: { ...testLimits, denseVectorPathsPerPage: 4 },
      }),
    );

    expect(resolveDensePageMode).not.toHaveBeenCalled();
    expect(result.page.dense).toBeUndefined();
    expect(result.page.fallback).toBeUndefined();
  });

  it('keeps page text and restores budgets when a page misses its deadline', async () => {
    const guarded = context(
      { limits: { ...testLimits, pageTimeoutMs: 20 } },
      'image-and-text',
    );
    const result = await readGuardedPage(
      densePage({
        render: () => ({ promise: new Promise(() => undefined) }),
      }) as never,
      1,
      guarded,
    );

    expect(result.page).toMatchObject({
      dense: true,
      fallback: { reason: 'timeout', mode: 'text-only' },
      images: [],
    });
    expect(result.page.spans.map(({ text }) => text)).toContain('Waarderen');
    expect(guarded.imageBudget).toEqual({ images: 0, pixels: 0 });
    expect(guarded.guard.timedOut).toBe(true);
  });

  it('reports a recoverable limit when even page text misses its deadline', async () => {
    await expect(
      readGuardedPage(
        densePage({
          getTextContent: () => new Promise(() => undefined),
        }) as never,
        1,
        context(
          { limits: { ...testLimits, pageTimeoutMs: 20 } },
          'image-and-text',
        ),
      ),
    ).rejects.toMatchObject({
      code: 'resource-limit',
      recoverable: true,
      details: { page: 1, limit: 20 },
    });
  });

  it('counts vector paths and keeps headings and prose but not isolated labels', () => {
    expect(
      countVectorPaths({
        fnArray: [OPS.constructPath, OPS.fill, OPS.constructPath],
        argsArray: [],
      } as never),
    ).toBe(2);
    const spans = [
      span('Section heading', 0.1, 0.1, { fontSize: 16, height: 0.03 }),
      span('First body line with several words', 0.1, 0.6, { fontSize: 10 }),
      span('second body line', 0.1, 0.625, { fontSize: 10 }),
      span('Label', 0.5, 0.35, { fontSize: 10, width: 0.08 }),
      span('12', 0.9, 0.95, { fontSize: 10, width: 0.03 }),
    ];

    expect(proseSpans(spans).map(({ text }) => text)).toEqual([
      'Section heading',
      'First body line with several words',
      'second body line',
      '12',
    ]);
  });

  it('resolves images shared across pages from the document object pool', async () => {
    const image = {
      width: 1,
      height: 1,
      kind: 3,
      data: Uint8Array.from([10, 20, 30, 255]),
    };
    const pageObjects = vi.fn();
    const page = {
      pageNumber: 2,
      getViewport: () => ({ width: 100, height: 100 }),
      objs: { get: pageObjects },
      commonObjs: {
        get: (_id: string, callback: (value: unknown) => void) =>
          callback(image),
      },
      getOperatorList: async () => ({
        fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [
          undefined,
          [20, 0, 0, 20, 10, 10],
          ['g_d0_img_p1_1'],
          undefined,
        ],
      }),
    };

    const images = await readImages(page as never, [1, 0, 0, 1, 0, 0], {
      ...testLimits,
      maxImagePixels: 10,
      maxTotalImagePixels: 10,
    });

    expect(images).toHaveLength(1);
    expect(pageObjects).not.toHaveBeenCalled();
  });

  it('asks once per document and reports dense pages converted with regular extraction', async () => {
    const resolveDensePageMode = vi.fn(async () => 'extract' as const);
    const result = await pdfJsReader.read(
      await fixture('two-column-article.pdf'),
      {
        conversionDate: '2026-01-01T00:00:00Z',
        figureRasterizer: rasterizer(),
        limits: { denseVectorPathsPerPage: 0 },
        resolveDensePageMode,
      },
    );

    expect(resolveDensePageMode).toHaveBeenCalledOnce();
    expect(result.analysis.densePages?.length).toBeGreaterThan(0);
    expect(result.analysis.fallbackPages ?? []).toEqual([]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-dense-pages-extracted' }),
    );
  });
});

function textOf(blocks: readonly unknown[]): string[] {
  const words: string[] = [];
  const walk = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const value = node as Record<string, unknown>;
      if (typeof value.text === 'string')
        words.push(...value.text.split(/\s+/).filter(Boolean));
      for (const key of ['children', 'blocks', 'rows', 'cells', 'caption'])
        if (Array.isArray(value[key])) walk(value[key] as unknown[]);
    }
  };
  walk(blocks);
  return words;
}

describe('PDF tagged table extraction', () => {
  const content = (markedContentId: string) => ({
    role: 'NonStruct',
    markedContentId,
    children: [],
  });
  const cell = (
    role: 'TH' | 'TD',
    markedContentIds: string[],
    spans: { colSpan?: number; rowSpan?: number } = {},
  ) => ({
    role,
    ...(spans.colSpan === undefined ? {} : { colSpan: spans.colSpan }),
    ...(spans.rowSpan === undefined ? {} : { rowSpan: spans.rowSpan }),
    children: markedContentIds.map(content),
  });
  const row = (cells: Array<{ role: string; children: unknown[] }>) => ({
    role: 'TR',
    children: cells,
  });

  it('builds a TableNode with header cells from a tagged table structure', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Quarter', 0.1, 0.2, { markedContentId: 'mc-h-quarter' }),
            span('Revenue', 0.6, 0.2, { markedContentId: 'mc-h-revenue' }),
            span('Q1', 0.1, 0.25, { markedContentId: 'mc-q1' }),
            span('100', 0.6, 0.25, { markedContentId: 'mc-r1-revenue' }),
            span('Q2', 0.1, 0.3, { markedContentId: 'mc-q2' }),
            span('120', 0.6, 0.3, { markedContentId: 'mc-r2-revenue' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'THead',
                    children: [
                      row([
                        cell('TH', ['mc-h-quarter']),
                        cell('TH', ['mc-h-revenue']),
                      ]),
                    ],
                  },
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TD', ['mc-q1']),
                        cell('TD', ['mc-r1-revenue']),
                      ]),
                      row([
                        cell('TD', ['mc-q2']),
                        cell('TD', ['mc-r2-revenue']),
                      ]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toEqual([
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                header: true,
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Quarter' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
              {
                header: true,
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Revenue' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q1' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: '100' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q2' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: '120' }],
                    styleId: 'pdf-body-11-regular-roman',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });
  it('keeps the text as paragraphs and warns when a declared table is ragged', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Quarter', 0.1, 0.2, { markedContentId: 'mc-h-quarter' }),
            span('Revenue', 0.6, 0.2, { markedContentId: 'mc-h-revenue' }),
            span('Q1', 0.1, 0.25, { markedContentId: 'mc-q1' }),
            span('100', 0.6, 0.25, { markedContentId: 'mc-r1-revenue' }),
            span('Notes', 0.8, 0.25, { markedContentId: 'mc-r1-notes' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TD', ['mc-h-quarter']),
                        cell('TD', ['mc-h-revenue']),
                      ]),
                      row([
                        cell('TD', ['mc-q1']),
                        cell('TD', ['mc-r1-revenue']),
                        cell('TD', ['mc-r1-notes']),
                      ]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.some(({ type }) => type === 'table')).toBe(
      false,
    );
    expect(textOf(result.model.blocks)).toEqual([
      'Quarter',
      'Revenue',
      'Q1',
      '100',
      'Notes',
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-table-structure-unresolved' }),
    );
  });
  it('reports detected tables in the analysis summary with provenance', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Period', 0.1, 0.2, { markedContentId: 'mc-h-period' }),
            span('Cost', 0.6, 0.2, { markedContentId: 'mc-h-cost' }),
            span('Jan', 0.1, 0.25, { markedContentId: 'mc-jan' }),
            span('10', 0.6, 0.25, { markedContentId: 'mc-jan-cost' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TH', ['mc-h-period']),
                        cell('TH', ['mc-h-cost']),
                      ]),
                      row([
                        cell('TD', ['mc-jan']),
                        cell('TD', ['mc-jan-cost']),
                      ]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.analysis.tables).toEqual([
      {
        page: 1,
        rows: 2,
        columns: 2,
        source: 'tagged',
        confidence: 'high',
      },
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-tables-detected' }),
    );
  });
  it('places a table where it sits in reading order between paragraphs', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Intro paragraph.', 0.1, 0.1, { markedContentId: 'mc-p1' }),
            span('A', 0.1, 0.3, { markedContentId: 'mc-a' }),
            span('B', 0.6, 0.3, { markedContentId: 'mc-b' }),
            span('Outro paragraph.', 0.1, 0.5, { markedContentId: 'mc-p2' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              { role: 'P', markedContentId: 'mc-p1', children: [] },
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([cell('TD', ['mc-a']), cell('TD', ['mc-b'])]),
                    ],
                  },
                ],
              },
              { role: 'P', markedContentId: 'mc-p2', children: [] },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.map(({ type }) => type)).toEqual([
      'paragraph',
      'table',
      'paragraph',
    ]);
    expect(textOf(result.model.blocks)).toEqual([
      'Intro',
      'paragraph.',
      'A',
      'B',
      'Outro',
      'paragraph.',
    ]);
  });
  it('moves a tagged table caption into the table caption', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Table 1', 0.1, 0.18, { markedContentId: 'mc-cap' }),
            span('Period', 0.1, 0.2, { markedContentId: 'mc-h-period' }),
            span('Cost', 0.6, 0.2, { markedContentId: 'mc-h-cost' }),
            span('Feb', 0.1, 0.25, { markedContentId: 'mc-feb' }),
            span('20', 0.6, 0.25, { markedContentId: 'mc-feb-cost' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'Caption',
                    children: [content('mc-cap')],
                  },
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TH', ['mc-h-period']),
                        cell('TH', ['mc-h-cost']),
                      ]),
                      row([
                        cell('TD', ['mc-feb']),
                        cell('TD', ['mc-feb-cost']),
                      ]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toHaveLength(1);
    expect(result.model.blocks[0]).toMatchObject({
      type: 'table',
      caption: [{ type: 'text', text: 'Table 1' }],
    });
    // Order-independent: this asserts no caption text is lost or duplicated.
    expect(textOf(result.model.blocks).sort()).toEqual(
      ['Table', '1', 'Period', 'Cost', 'Feb', '20'].sort(),
    );
  });
  it('keeps cells the PDF declares with colSpan and rowSpan', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Total', 0.1, 0.2, { markedContentId: 'mc-total' }),
            span('Revenue', 0.6, 0.2, { markedContentId: 'mc-revenue' }),
            span('100', 0.6, 0.25, { markedContentId: 'mc-100' }),
            span('Q1', 0.1, 0.3, { markedContentId: 'mc-q1' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TD', ['mc-total'], { rowSpan: 2 }),
                        cell('TD', ['mc-revenue']),
                      ]),
                      row([cell('TD', ['mc-100'])]),
                      row([cell('TD', ['mc-q1']), cell('TD', [])]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toEqual([
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Total' }],
                    styleId: expect.any(String),
                  },
                ],
                rowSpan: 2,
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Revenue' }],
                    styleId: expect.any(String),
                  },
                ],
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: '100' }],
                    styleId: expect.any(String),
                  },
                ],
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q1' }],
                    styleId: expect.any(String),
                  },
                ],
              },
              { blocks: [] },
            ],
          },
        ],
      },
    ]);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 3, columns: 2, source: 'tagged', confidence: 'high' },
    ]);
  });
  it('places a colSpan cell across the columns it declares', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Years 2025 and 2026', 0.1, 0.2, {
              markedContentId: 'mc-wide',
            }),
            span('Q1', 0.1, 0.25, { markedContentId: 'mc-q1' }),
            span('Q2', 0.6, 0.25, { markedContentId: 'mc-q2' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([cell('TD', ['mc-wide'], { colSpan: 2 })]),
                      row([cell('TD', ['mc-q1']), cell('TD', ['mc-q2'])]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks).toEqual([
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Years 2025 and 2026' }],
                    styleId: expect.any(String),
                  },
                ],
                colSpan: 2,
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q1' }],
                    styleId: expect.any(String),
                  },
                ],
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q2' }],
                    styleId: expect.any(String),
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 2, columns: 2, source: 'tagged', confidence: 'high' },
    ]);
  });
  it('marks cells of a THead row as header even when their role is TD', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Period', 0.1, 0.2, { markedContentId: 'mc-h1' }),
            span('Revenue', 0.6, 0.2, { markedContentId: 'mc-h2' }),
            span('Q1', 0.1, 0.25, { markedContentId: 'mc-b1' }),
            span('100', 0.6, 0.25, { markedContentId: 'mc-b2' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'THead',
                    children: [
                      row([cell('TD', ['mc-h1']), cell('TD', ['mc-h2'])]),
                    ],
                  },
                  {
                    role: 'TBody',
                    children: [
                      row([cell('TD', ['mc-b1']), cell('TD', ['mc-b2'])]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    const [table] = result.model.blocks as Array<{
      type: string;
      rows: Array<{ cells: Array<{ header?: boolean }> }>;
    }>;
    expect(table?.rows[0]?.cells.map(({ header }) => header)).toEqual([
      true,
      true,
    ]);
    expect(table?.rows[1]?.cells.map(({ header }) => header)).toEqual([
      undefined,
      undefined,
    ]);
  });
  it('keeps text as paragraphs when declared spans overlap', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('A', 0.1, 0.2, { markedContentId: 'mc-a' }),
            span('B', 0.6, 0.2, { markedContentId: 'mc-b' }),
            span('C', 0.1, 0.25, { markedContentId: 'mc-c' }),
            span('D', 0.6, 0.25, { markedContentId: 'mc-d' }),
          ],
          links: [],
          images: [],
          taggedStructure: {
            role: 'Root',
            children: [
              {
                role: 'Table',
                children: [
                  {
                    role: 'TBody',
                    children: [
                      row([
                        cell('TD', ['mc-a'], { rowSpan: 2 }),
                        cell('TD', ['mc-b']),
                      ]),
                      row([cell('TD', ['mc-c']), cell('TD', ['mc-d'])]),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.some(({ type }) => type === 'table')).toBe(
      false,
    );
    expect(textOf(result.model.blocks)).toEqual(['A', 'B', 'C', 'D']);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-table-structure-unresolved' }),
    );
  });
  it('reads declared row and column spans from a real PDF', async () => {
    const result = await pdfJsReader.read(
      await fixture('tagged-table-spans.pdf'),
      {
        conversionDate: '2026-08-29',
      },
    );

    expect(result.model.blocks).toEqual([
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Metric' }],
                    styleId: expect.any(String),
                  },
                ],
                header: true,
                rowSpan: 2,
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Revenue' }],
                    styleId: expect.any(String),
                  },
                ],
                header: true,
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Cost' }],
                    styleId: expect.any(String),
                  },
                ],
                header: true,
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Total revenue' }],
                    styleId: expect.any(String),
                  },
                ],
                colSpan: 2,
              },
            ],
          },
        ],
      },
    ]);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 3, columns: 2, source: 'tagged', confidence: 'high' },
    ]);
    expect(textOf(result.model.blocks)).toEqual([
      'Metric',
      'Revenue',
      'Cost',
      'Total',
      'revenue',
    ]);
  });
  it('reads a tagged table from a real PDF into a table block', async () => {
    const result = await pdfJsReader.read(await fixture('tagged-table.pdf'), {
      conversionDate: '2026-08-29',
    });

    expect(result.model.blocks).toEqual([
      {
        type: 'table',
        caption: [{ type: 'text', text: 'Table 1: quarterly revenue' }],
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Period' }],
                    styleId: expect.any(String),
                  },
                ],
                header: true,
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Revenue' }],
                    styleId: expect.any(String),
                  },
                ],
                header: true,
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q1' }],
                    styleId: expect.any(String),
                  },
                ],
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: '100' }],
                    styleId: expect.any(String),
                  },
                ],
              },
            ],
          },
          {
            cells: [
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Q2' }],
                    styleId: expect.any(String),
                  },
                ],
              },
              {
                blocks: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: '120' }],
                    styleId: expect.any(String),
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 3, columns: 2, source: 'tagged', confidence: 'high' },
    ]);
    // No text loss: every string the fixture draws reaches the output exactly
    // once, whether it landed in a cell or in the caption.
    expect(textOf(result.model.blocks)).toEqual([
      'Period',
      'Revenue',
      'Q1',
      '100',
      'Q2',
      '120',
      'Table',
      '1:',
      'quarterly',
      'revenue',
    ]);
  });
});

describe('PDF stroke segment collection', () => {
  const viewport = (width: number, height: number) =>
    ({ width, height, transform: [1, 0, 0, -1, 0, height] }) as never;

  function pathOps(
    entries: Array<{
      path: readonly number[];
      paint?: number;
      lineWidth?: number;
      color?: 'black' | 'white';
    }>,
  ): { fnArray: number[]; argsArray: unknown[] } {
    const fnArray: number[] = [];
    const argsArray: unknown[] = [];
    for (const entry of entries) {
      if (entry.lineWidth !== undefined) {
        fnArray.push(OPS.setLineWidth);
        argsArray.push([entry.lineWidth]);
      }
      if (entry.color) {
        fnArray.push(OPS.setStrokeRGBColor);
        argsArray.push(entry.color === 'white' ? [255, 255, 255] : [0, 0, 0]);
      }
      fnArray.push(OPS.constructPath);
      argsArray.push([entry.paint ?? OPS.stroke, [entry.path], undefined]);
    }
    return { fnArray, argsArray };
  }

  it('reports stroked lines as page-relative segments', () => {
    const collected = collectStrokeSegments(
      pathOps([{ path: [0, 0, 100, 1, 400, 100], lineWidth: 1 }]),
      viewport(400, 200),
    );
    expect(collected.truncated).toBe(false);
    expect(collected.segments).toEqual([
      {
        x1: 0,
        y1: 0.5,
        x2: 1,
        y2: 0.5,
        width: expect.closeTo(1 / 400, 6),
      },
    ]);
  });

  it('expands a stroked rectangle into its four rules', () => {
    // `40 200 300 60 re S` arrives as moveTo, three lineTo and closePath.
    const collected = collectStrokeSegments(
      pathOps([
        {
          path: [0, 40, 200, 1, 340, 200, 1, 340, 260, 1, 40, 260, 4],
        },
      ]),
      viewport(400, 300),
    );
    expect(collected.segments).toHaveLength(4);
    expect(collected.segments.map(({ y1 }) => y1)).toEqual([
      expect.closeTo((300 - 200) / 300, 6),
      expect.closeTo((300 - 200) / 300, 6),
      expect.closeTo((300 - 260) / 300, 6),
      expect.closeTo((300 - 260) / 300, 6),
    ]);
  });

  it('ignores filled areas, curves and strokes painted white', () => {
    const collected = collectStrokeSegments(
      pathOps([
        { path: [0, 0, 10, 1, 100, 10], paint: OPS.fill },
        { path: [0, 0, 10, 2, 10, 10, 20, 10, 30, 10, 40, 10] },
        { path: [0, 0, 10, 1, 100, 10], color: 'white' },
        { path: [0, 0, 10, 1, 100, 10], lineWidth: 0 },
      ]),
      viewport(400, 200),
    );
    expect(collected.segments).toEqual([]);
  });

  it('keeps stroked-and-filled paths, which are bordered cells', () => {
    const collected = collectStrokeSegments(
      pathOps([
        { path: [0, 0, 10, 1, 100, 10], paint: OPS.fillStroke },
        { path: [0, 0, 10, 1, 100, 10], paint: OPS.closeStroke },
      ]),
      viewport(400, 200),
    );
    expect(collected.segments).toHaveLength(2);
  });

  it('stops at the segment limit and says so', () => {
    const collected = collectStrokeSegments(
      pathOps(
        Array.from({ length: 6 }, () => ({
          path: [0, 0, 10, 1, 100, 10] as number[],
        })),
      ),
      viewport(400, 200),
      3,
    );
    expect(collected.segments).toHaveLength(3);
    expect(collected.truncated).toBe(true);
  });
});

describe('PDF ruled table detection', () => {
  const rule = (x1: number, y1: number, x2: number, y2: number) => ({
    x1,
    y1,
    x2,
    y2,
    width: 0.0025,
  });
  /** A closed rowCount x columnCount lattice. */
  function lattice(xs: readonly number[], ys: readonly number[]) {
    const strokes: RawPdfStrokeSegment[] = [];
    for (const x of xs) strokes.push(rule(x, ys[0]!, x, ys.at(-1)!));
    for (const y of ys) strokes.push(rule(xs[0]!, y, xs.at(-1)!, y));
    return strokes;
  }
  const cellSpan = (
    text: string,
    xs: readonly number[],
    ys: readonly number[],
    row: number,
    column: number,
  ) =>
    span(text, xs[column]! + 0.02, ys[row]! + 0.02, {
      width: xs[column + 1]! - xs[column]! - 0.04,
      height: ys[row + 1]! - ys[row]! - 0.04,
      id: text,
    });

  const xs = [0.1, 0.4, 0.7];
  const ys = [0.2, 0.35, 0.5];

  it('builds a grid from rules that close every cell', () => {
    const discovery = detectRuledTables(
      [
        cellSpan('Quarter', xs, ys, 0, 0),
        cellSpan('Revenue', xs, ys, 0, 1),
        cellSpan('Q1', xs, ys, 1, 0),
        cellSpan('100', xs, ys, 1, 1),
      ],
      lattice(xs, ys),
    );
    expect(discovery.unresolved).toBe(0);
    expect(discovery.tables).toHaveLength(1);
    const [table] = discovery.tables;
    expect(table?.rowCount).toBe(2);
    expect(table?.columnCount).toBe(2);
    expect(table?.cells.map(({ spanIds }) => spanIds)).toEqual([
      ['Quarter'],
      ['Revenue'],
      ['Q1'],
      ['100'],
    ]);
  });

  it('does not turn an underlined heading into a table', () => {
    const discovery = detectRuledTables(
      [span('Chapter one', 0.1, 0.2, { width: 0.4 })],
      [rule(0.1, 0.24, 0.5, 0.24)],
    );
    expect(discovery.tables).toEqual([]);
  });

  it('rejects the whole grid when one cell is not closed', () => {
    // The middle horizontal rule stops short, so the right-hand cells leak.
    const strokes = lattice(xs, ys).filter(
      (segment) =>
        !(
          Math.abs(segment.y1 - ys[1]!) < 1e-9 &&
          Math.abs(segment.x2 - xs[2]!) < 1e-9
        ),
    );
    strokes.push(rule(xs[0]!, ys[1]!, xs[1]!, ys[1]!));
    const discovery = detectRuledTables(
      [
        cellSpan('Quarter', xs, ys, 0, 0),
        cellSpan('Revenue', xs, ys, 0, 1),
        cellSpan('Q1', xs, ys, 1, 0),
        cellSpan('100', xs, ys, 1, 1),
      ],
      strokes,
    );
    expect(discovery.tables).toEqual([]);
    expect(discovery.unresolved).toBe(1);
  });

  it('rejects a span that straddles an interior rule', () => {
    const discovery = detectRuledTables(
      [
        cellSpan('Quarter', xs, ys, 0, 0),
        cellSpan('Revenue', xs, ys, 0, 1),
        cellSpan('Q1', xs, ys, 1, 0),
        span('a run across both columns', 0.2, 0.4, {
          width: 0.4,
          height: 0.06,
          id: 'straddling',
        }),
      ],
      lattice(xs, ys),
    );
    expect(discovery.tables).toEqual([]);
    expect(discovery.unresolved).toBe(1);
  });

  it('leaves text outside the grid to the paragraph path', () => {
    const discovery = detectRuledTables(
      [
        span('Table 1: quarterly revenue', 0.1, 0.1, {
          width: 0.5,
          height: 0.02,
          id: 'caption',
        }),
        cellSpan('Q1', xs, ys, 0, 0),
        cellSpan('100', xs, ys, 0, 1),
        cellSpan('Q2', xs, ys, 1, 0),
        cellSpan('120', xs, ys, 1, 1),
      ],
      lattice(xs, ys),
    );
    expect(
      discovery.tables[0]?.cells.flatMap(({ spanIds }) => spanIds),
    ).not.toContain('caption');
  });

  it('rejects a grid that holds text in only one cell', () => {
    const discovery = detectRuledTables(
      [cellSpan('Q1', xs, ys, 0, 0)],
      lattice(xs, ys),
    );
    expect(discovery.tables).toEqual([]);
  });

  it('reports two separated lattices as two tables', () => {
    const lower = [0.7, 0.775, 0.85];
    const discovery = detectRuledTables(
      [
        cellSpan('A', xs, ys, 0, 0),
        cellSpan('B', xs, ys, 0, 1),
        cellSpan('C', xs, ys, 1, 0),
        cellSpan('D', xs, ys, 1, 1),
        cellSpan('E', xs, lower, 0, 0),
        cellSpan('F', xs, lower, 0, 1),
        cellSpan('G', xs, lower, 1, 0),
        cellSpan('H', xs, lower, 1, 1),
      ],
      [...lattice(xs, ys), ...lattice(xs, lower)],
    );
    expect(discovery.tables).toHaveLength(2);
    expect(discovery.tables.map(({ rowCount }) => rowCount)).toEqual([2, 2]);
    expect(discovery.tables.map(({ cells }) => cells[0]?.spanIds)).toEqual([
      ['A'],
      ['E'],
    ]);
  });

  it('reports truncation rather than guessing past the stroke budget', () => {
    const discovery = detectRuledTables(
      [
        cellSpan('Q1', xs, ys, 0, 0),
        cellSpan('100', xs, ys, 0, 1),
        cellSpan('Q2', xs, ys, 1, 0),
        cellSpan('120', xs, ys, 1, 1),
      ],
      lattice(xs, ys),
      { ...DEFAULT_RULED_TABLE_LIMITS, maxStrokes: 2 },
    );
    expect(discovery.tables).toEqual([]);
    expect(discovery.truncated).toBe(true);
  });
});

describe('PDF ruled table extraction', () => {
  const xs = [0.1, 0.4, 0.7];
  const ys = [0.2, 0.35, 0.5];
  const rule = (x1: number, y1: number, x2: number, y2: number) => ({
    x1,
    y1,
    x2,
    y2,
    width: 0.0025,
  });
  function lattice(): RawPdfStrokeSegment[] {
    const strokes: RawPdfStrokeSegment[] = [];
    for (const x of xs) strokes.push(rule(x, ys[0]!, x, ys.at(-1)!));
    for (const y of ys) strokes.push(rule(xs[0]!, y, xs.at(-1)!, y));
    return strokes;
  }
  const cellText = (text: string, row: number, column: number) =>
    span(text, xs[column]! + 0.02, ys[row]! + 0.02, {
      width: xs[column + 1]! - xs[column]! - 0.04,
      height: ys[row + 1]! - ys[row]! - 0.04,
    });
  const pageOf = (
    spans: RawPdfTextSpan[],
    strokes: RawPdfStrokeSegment[],
    extra: Partial<RawPdfDocument['pages'][number]> = {},
  ) => ({
    number: 1,
    width: 600,
    height: 800,
    rotation: 0,
    spans,
    links: [],
    images: [],
    strokes,
    ...extra,
  });

  it('turns a closed grid of rules into a table block', async () => {
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            cellText('Quarter', 0, 0),
            cellText('Revenue', 0, 1),
            cellText('Q1', 1, 0),
            cellText('100', 1, 1),
          ],
          lattice(),
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(
      result.model.blocks.filter(({ type }) => type === 'table'),
    ).toHaveLength(1);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 2, columns: 2, source: 'ruled', confidence: 'medium' },
    ]);
    // No duplication: the grid text reached the table and not the paragraph path.
    expect(textOf(result.model.blocks)).toEqual([
      'Quarter',
      'Revenue',
      'Q1',
      '100',
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-tables-detected' }),
    );
  });

  it('represents a ruled cell that spans columns when its text crosses the missing rule', async () => {
    const strokes = [
      rule(xs[0]!, ys[0]!, xs[0]!, ys.at(-1)!),
      rule(xs[1]!, ys[1]!, xs[1]!, ys.at(-1)!),
      rule(xs[2]!, ys[0]!, xs[2]!, ys.at(-1)!),
      ...ys.map((y) => rule(xs[0]!, y, xs.at(-1)!, y)),
    ];
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            span('Total revenue', xs[0]! + 0.02, ys[0]! + 0.02, {
              width: xs[2]! - xs[0]! - 0.04,
              height: ys[1]! - ys[0]! - 0.04,
            }),
            cellText('Q1', 1, 0),
            cellText('100', 1, 1),
          ],
          strokes,
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );
    const [table] = result.model.blocks.filter(({ type }) => type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(
      table.rows.map(({ cells }) => cells.map((cell) => cell.colSpan ?? 1)),
    ).toEqual([[2], [1, 1]]);
    expect(textOf(result.model.blocks)).toEqual([
      'Total',
      'revenue',
      'Q1',
      '100',
    ]);
  });

  it('represents a ruled cell that spans rows when its text crosses the missing rule', async () => {
    const strokes = [
      ...xs.map((x) => rule(x, ys[0]!, x, ys.at(-1)!)),
      rule(xs[0]!, ys[0]!, xs[2]!, ys[0]!),
      rule(xs[1]!, ys[1]!, xs[2]!, ys[1]!),
      rule(xs[0]!, ys[2]!, xs[2]!, ys[2]!),
    ];
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            span('Metric', xs[0]! + 0.02, ys[0]! + 0.02, {
              width: xs[1]! - xs[0]! - 0.04,
              height: ys[2]! - ys[0]! - 0.04,
            }),
            cellText('Q1', 0, 1),
            cellText('Q2', 1, 1),
          ],
          strokes,
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );
    const [table] = result.model.blocks.filter(({ type }) => type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(
      table.rows.map(({ cells }) => cells.map((cell) => cell.rowSpan ?? 1)),
    ).toEqual([[2, 1], [1]]);
    expect(textOf(result.model.blocks)).toEqual(['Metric', 'Q1', 'Q2']);
  });

  it('keeps every word as prose when the rules do not close a grid', async () => {
    // Three boundaries each way, but the middle horizontal stops short, so the
    // right-hand cells are open: grid-shaped, and refused.
    const strokes = lattice()
      .filter((segment) => !(segment.y1 === ys[1] && segment.y2 === ys[1]))
      .concat(rule(xs[0]!, ys[1]!, xs[1]!, ys[1]!));
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            cellText('Quarter', 0, 0),
            cellText('Revenue', 0, 1),
            cellText('Q1', 1, 0),
            cellText('100', 1, 1),
          ],
          strokes,
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.some(({ type }) => type === 'table')).toBe(
      false,
    );
    expect(textOf(result.model.blocks)).toEqual([
      'Quarter',
      'Revenue',
      'Q1',
      '100',
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-table-structure-unresolved' }),
    );
  });

  it('leaves the caption above the grid as a paragraph', async () => {
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            span('Table 1', 0.1, 0.12, { width: 0.12, height: 0.02 }),
            cellText('Quarter', 0, 0),
            cellText('Revenue', 0, 1),
            cellText('Q1', 1, 0),
            cellText('100', 1, 1),
          ],
          lattice(),
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(textOf(result.model.blocks)).toEqual([
      'Table',
      '1',
      'Quarter',
      'Revenue',
      'Q1',
      '100',
    ]);
    const [table] = result.model.blocks.filter(({ type }) => type === 'table');
    expect(table).toBeDefined();
  });

  it('stays silent on a page whose stroke budget was exhausted', async () => {
    const result = await analysePdf(
      rawDocument([
        pageOf(
          [
            cellText('Quarter', 0, 0),
            cellText('Revenue', 0, 1),
            cellText('Q1', 1, 0),
            cellText('100', 1, 1),
          ],
          lattice(),
          { strokesTruncated: true },
        ),
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.some(({ type }) => type === 'table')).toBe(
      false,
    );
    expect(textOf(result.model.blocks)).toEqual([
      'Quarter',
      'Revenue',
      'Q1',
      '100',
    ]);
    expect(result.model.warnings.map(({ code }) => code)).not.toContain(
      'pdf-tables-detected',
    );
  });
  it('reads a ruled table from a real PDF into a table block', async () => {
    const result = await pdfJsReader.read(await fixture('ruled-table.pdf'), {
      conversionDate: '2026-08-29',
    });

    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 3, columns: 2, source: 'ruled', confidence: 'medium' },
    ]);
    const [table] = result.model.blocks.filter(({ type }) => type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(
      table.rows.map((row) => row.cells.map((cell) => textOf(cell.blocks))),
    ).toEqual([
      [['Period'], ['Revenue']],
      [['Q1'], ['100']],
      [['Q2'], ['120']],
    ]);
    // The caption sits outside the closed grid, so it stays a paragraph and no
    // word is lost or repeated.
    expect(textOf(result.model.blocks)).toEqual([
      'Quarterly',
      'revenue',
      'Period',
      'Revenue',
      'Q1',
      '100',
      'Q2',
      '120',
    ]);
  });

  it('reads ruled row and column spans from a real PDF', async () => {
    const result = await pdfJsReader.read(
      await fixture('ruled-table-spans.pdf'),
      { conversionDate: '2026-08-29' },
    );
    const [table] = result.model.blocks.filter(({ type }) => type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 3, columns: 3, source: 'ruled', confidence: 'medium' },
    ]);
    expect(
      table.rows.map((row) =>
        row.cells.map((cell) => [cell.rowSpan ?? 1, cell.colSpan ?? 1]),
      ),
    ).toEqual([
      [
        [2, 1],
        [1, 2],
      ],
      [
        [1, 1],
        [1, 1],
      ],
      [
        [1, 1],
        [1, 1],
        [1, 1],
      ],
    ]);
    expect(
      table.rows.map((row) =>
        row.cells.map((cell) => textOf(cell.blocks).join(' ')),
      ),
    ).toEqual([
      ['Metric', 'Total revenue'],
      ['Q1', '100'],
      ['Q2', '120', '140'],
    ]);
    expect(textOf(result.model.blocks).sort()).toEqual(
      ['Metric', 'Total', 'revenue', 'Q1', '100', 'Q2', '120', '140'].sort(),
    );
  });

  it('refuses separators, boxes, chart axes and an open grid', async () => {
    const result = await pdfJsReader.read(
      await fixture('ruled-non-tables.pdf'),
      { conversionDate: '2026-08-29' },
    );

    expect(result.model.blocks.some(({ type }) => type === 'table')).toBe(
      false,
    );
    expect(result.analysis.tables).toBeUndefined();
    expect(textOf(result.model.blocks)).toEqual([
      'Chapter',
      'heading',
      'Indented',
      'quotation',
      'Figure',
      '2',
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    // The grid-shaped failure is reported instead of guessed at.
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-table-structure-unresolved' }),
    );
  });
});

describe('PDF corpus table guard', () => {
  it('finds tables only in the fixtures that declare or draw one', async () => {
    const directory = new URL('../../../tests/fixtures/pdf/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.pdf'))
      .sort();
    const found: Record<string, string> = {};
    for (const name of names) {
      try {
        const result = await pdfJsReader.read(
          new Uint8Array(await readFile(new URL(name, directory))),
          { conversionDate: '2026-08-29', password: 'fixture-password' },
        );
        const tables = result.analysis.tables ?? [];
        if (tables.length > 0)
          found[name] = tables
            .map(({ source, rows, columns }) => `${source}:${rows}x${columns}`)
            .join(',');
      } catch {
        // Encrypted and malformed fixtures have their own tests.
      }
    }
    expect(found).toEqual({
      'ruled-table.pdf': 'ruled:3x2',
      'ruled-table-spans.pdf': 'ruled:3x3',
      'tagged-table.pdf': 'tagged:3x2',
      'tagged-table-spans.pdf': 'tagged:3x2',
    });
  }, 120_000);

  // Borderless inference is the risky signal, so the whole corpus is read with
  // it switched on: only the fixture that aligns columns may become a table.
  it('finds borderless tables only where columns are aligned on purpose', async () => {
    const directory = new URL('../../../tests/fixtures/pdf/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.pdf'))
      .sort();
    const found: Record<string, string> = {};
    for (const name of names) {
      try {
        const result = await pdfJsReader.read(
          new Uint8Array(await readFile(new URL(name, directory))),
          {
            conversionDate: '2026-08-29',
            password: 'fixture-password',
            pdfTables: { borderless: true },
          },
        );
        const tables = result.analysis.tables ?? [];
        if (tables.length > 0)
          found[name] = tables
            .map(({ source, rows, columns }) => `${source}:${rows}x${columns}`)
            .join(',');
      } catch {
        // Encrypted and malformed fixtures have their own tests.
      }
    }
    expect(found).toEqual({
      'borderless-table.pdf': 'borderless:4x3',
      'formula-false-positives.pdf': 'borderless:3x4',
      'ruled-table.pdf': 'ruled:3x2',
      'ruled-table-spans.pdf': 'ruled:3x3',
      'tagged-table.pdf': 'tagged:3x2',
      'tagged-table-spans.pdf': 'tagged:3x2',
    });
  }, 120_000);
});

describe('PDF borderless table detection', () => {
  const columns = [0.1, 0.45, 0.7];
  const rows = [0.2, 0.25, 0.3, 0.35];
  const cell = (text: string, row: number, column: number, width = 0.08) => ({
    id: text,
    text,
    x: columns[column]!,
    top: rows[row]!,
    width,
    height: 0.02,
  });
  const grid = (rowsTaken: number, columnsTaken = 3) =>
    Array.from({ length: rowsTaken }, (_, row) =>
      Array.from({ length: columnsTaken }, (_, column) =>
        cell(`${row}-${column}`, row, column),
      ),
    ).flat();

  it('finds a table in aligned columns without any rules', () => {
    const discovery = detectBorderlessTables(grid(4));
    expect(discovery.unresolved).toBe(0);
    expect(discovery.tables).toHaveLength(1);
    const [table] = discovery.tables;
    expect(table?.source).toBe('borderless');
    expect(table?.rowCount).toBe(4);
    expect(table?.columnCount).toBe(3);
    expect(table?.cells.map(({ spanIds }) => spanIds)).toEqual([
      ['0-0'],
      ['0-1'],
      ['0-2'],
      ['1-0'],
      ['1-1'],
      ['1-2'],
      ['2-0'],
      ['2-1'],
      ['2-2'],
      ['3-0'],
      ['3-1'],
      ['3-2'],
    ]);
  });

  it('refuses a block with too few rows without calling it unresolved', () => {
    const discovery = detectBorderlessTables(grid(2));
    expect(discovery.tables).toEqual([]);
    expect(discovery.unresolved).toBe(0);
  });

  it('refuses a block containing a wrapped line', () => {
    const spans = grid(4);
    spans.push({
      id: 'wrapped',
      text: 'and the sentence carries on',
      x: 0.28,
      top: rows[2]!,
      width: 0.2,
      height: 0.02,
    });
    const discovery = detectBorderlessTables(spans);
    expect(discovery.tables).toEqual([]);
  });

  it('refuses two-column prose whose lines fill their columns', () => {
    const prose = Array.from({ length: 5 }, (_, row) => [
      {
        id: `left-${row}`,
        text: 'the line runs nearly to the column edge',
        x: 0.1,
        top: 0.2 + row * 0.05,
        width: 0.42,
        height: 0.02,
      },
      {
        id: `right-${row}`,
        text: 'and the second column does the same',
        x: 0.55,
        top: 0.2 + row * 0.05,
        width: 0.42,
        height: 0.02,
      },
    ]).flat();
    // Correctly refused, so nothing is reported: prose was never a table.
    const discovery = detectBorderlessTables(prose);
    expect(discovery.tables).toEqual([]);
    expect(discovery.unresolved).toBe(0);
  });

  it('refuses a bulleted list', () => {
    const list = Array.from({ length: 4 }, (_, row) => [
      {
        id: `bullet-${row}`,
        text: '•',
        x: 0.1,
        top: 0.2 + row * 0.05,
        width: 0.01,
        height: 0.02,
      },
      {
        id: `item-${row}`,
        text: `item number ${row}`,
        x: 0.16,
        top: 0.2 + row * 0.05,
        width: 0.3,
        height: 0.02,
      },
    ]).flat();
    expect(detectBorderlessTables(list).tables).toEqual([]);
  });

  it('refuses a numbered list', () => {
    const list = Array.from({ length: 4 }, (_, row) => [
      {
        id: `number-${row}`,
        text: `${row + 1}.`,
        x: 0.1,
        top: 0.2 + row * 0.05,
        width: 0.02,
        height: 0.02,
      },
      {
        id: `item-${row}`,
        text: `item number ${row}`,
        x: 0.16,
        top: 0.2 + row * 0.05,
        width: 0.3,
        height: 0.02,
      },
    ]).flat();
    expect(detectBorderlessTables(list).tables).toEqual([]);
  });

  it('keeps a heading above the block out of the table', () => {
    const discovery = detectBorderlessTables([
      {
        id: 'heading',
        text: 'Quarterly figures',
        x: 0.1,
        top: 0.12,
        width: 0.2,
        height: 0.03,
      },
      ...grid(4),
    ]);
    expect(discovery.tables).toHaveLength(1);
    expect(
      discovery.tables[0]?.cells.flatMap(({ spanIds }) => spanIds),
    ).not.toContain('heading');
  });

  it('reports two separated blocks as two tables', () => {
    const lower = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) => ({
        id: `lower-${row}-${column}`,
        text: `${row}-${column}`,
        x: columns[column]!,
        top: 0.6 + row * 0.05,
        width: 0.08,
        height: 0.02,
      })),
    ).flat();
    const discovery = detectBorderlessTables([...grid(4), ...lower]);
    expect(discovery.tables).toHaveLength(2);
    expect(discovery.tables.map(({ rowCount }) => rowCount)).toEqual([4, 4]);
  });

  it('reports a grid wider than the column budget as unresolved', () => {
    const discovery = detectBorderlessTables(grid(4), {
      ...DEFAULT_BORDERLESS_TABLE_LIMITS,
      maxColumnsPerTable: 2,
    });
    expect(discovery.tables).toEqual([]);
    expect(discovery.unresolved).toBe(1);
  });

  it('reports truncation rather than guessing past the span budget', () => {
    const discovery = detectBorderlessTables(grid(4), {
      ...DEFAULT_BORDERLESS_TABLE_LIMITS,
      maxSpans: 3,
    });
    expect(discovery.tables).toEqual([]);
    expect(discovery.truncated).toBe(true);
  });
});

describe('PDF table signals', () => {
  const columns = [0.07, 0.32, 0.55];
  const rowTops = [0.15, 0.18, 0.21, 0.24];
  const cellText = [
    ['Region', 'Units', 'Share'],
    ['North', '120', '31%'],
    ['South', '98', '25%'],
    ['East', '141', '44%'],
  ];
  const alignedSpans = () =>
    rowTops.flatMap((top, row) =>
      columns.map((x, column) =>
        span(cellText[row]![column]!, x, top, { width: 0.06, height: 0.012 }),
      ),
    );
  const pageWith = (spans: RawPdfTextSpan[]) =>
    rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans,
        links: [],
        images: [],
      },
    ]);

  it('keeps aligned columns as prose unless borderless tables are enabled', async () => {
    const result = await analysePdf(pageWith(alignedSpans()), {
      filename: 'aligned.pdf',
    });
    expect(
      result.model.blocks.filter((block) => block.type === 'table'),
    ).toEqual([]);
    expect(result.analysis.tables).toBeUndefined();
  });

  it('emits a table from aligned columns when borderless tables are enabled', async () => {
    const result = await analysePdf(pageWith(alignedSpans()), {
      filename: 'aligned.pdf',
      pdfTables: { borderless: true },
    });
    const tables = result.model.blocks.filter(
      (block) => block.type === 'table',
    );
    expect(tables).toHaveLength(1);
    const table = tables[0];
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.rows.map((row) => row.cells.length)).toEqual([3, 3, 3, 3]);
    expect(
      table.rows.map((row) =>
        row.cells.map((cell) =>
          cell.blocks
            .map((block) =>
              block.type === 'paragraph'
                ? block.children
                    .map((child) => (child.type === 'text' ? child.text : ''))
                    .join('')
                : '',
            )
            .join(''),
        ),
      ),
    ).toEqual(cellText);
    expect(result.analysis.tables).toEqual([
      { page: 1, rows: 4, columns: 3, source: 'borderless', confidence: 'low' },
    ]);
  });

  it('refuses a bulleted list even with borderless tables enabled', async () => {
    const list = Array.from({ length: 4 }, (_, row) => [
      span('•', 0.04, 0.35 + row * 0.03, { width: 0.006, height: 0.012 }),
      span(`item ${row}`, 0.085, 0.35 + row * 0.03, {
        width: 0.2,
        height: 0.012,
      }),
    ]).flat();
    const result = await analysePdf(pageWith([...alignedSpans(), ...list]), {
      filename: 'aligned.pdf',
      pdfTables: { borderless: true },
    });
    const tables = result.model.blocks.filter(
      (block) => block.type === 'table',
    );
    expect(tables).toHaveLength(1);
    const text = JSON.stringify(result.model.blocks);
    expect(text).toContain('item 0');
    expect(text).toContain('item 3');
  });

  it('skips tagged tables when the tagged signal is turned off', async () => {
    const result = await pdfJsReader.read(await fixture('tagged-table.pdf'), {
      filename: 'tagged-table.pdf',
      pdfTables: { tagged: false },
    });
    expect(
      result.model.blocks.filter((block) => block.type === 'table'),
    ).toEqual([]);
    expect(JSON.stringify(result.model.blocks)).toContain('Period');
    expect(JSON.stringify(result.model.blocks)).toContain('120');
  });

  it('skips ruled tables when the ruled signal is turned off', async () => {
    const result = await pdfJsReader.read(await fixture('ruled-table.pdf'), {
      filename: 'ruled-table.pdf',
      pdfTables: { ruled: false },
    });
    expect(
      result.model.blocks.filter((block) => block.type === 'table'),
    ).toEqual([]);
    expect(JSON.stringify(result.model.blocks)).toContain('Revenue');
  });

  it('reads a borderless table from a real page only when enabled', async () => {
    const without = await pdfJsReader.read(
      await fixture('borderless-table.pdf'),
      { filename: 'borderless-table.pdf' },
    );
    expect(
      without.model.blocks.filter((block) => block.type === 'table'),
    ).toEqual([]);
    const withBorders = await pdfJsReader.read(
      await fixture('borderless-table.pdf'),
      { filename: 'borderless-table.pdf', pdfTables: { borderless: true } },
    );
    const tables = withBorders.model.blocks.filter(
      (block) => block.type === 'table',
    );
    expect(tables).toHaveLength(1);
    expect(withBorders.analysis.tables).toEqual([
      { page: 1, rows: 4, columns: 3, source: 'borderless', confidence: 'low' },
    ]);
    const text = JSON.stringify(withBorders.model.blocks);
    expect(text).toContain('Distribution');
    expect(text).toContain('figures are unaudited');
    expect(text).toContain('44%');
  });

  it('reports suspicious column interleaving for review', async () => {
    const spans = [0.1, 0.4, 0.7].flatMap((x, column) =>
      [0.2, 0.24, 0.28].map((top, row) =>
        span(`column ${column} row ${row}`, x, top, { width: 0.2 }),
      ),
    );
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans,
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );

    expect(result.analysis.reflowIssues).toEqual([
      { page: 1, columns: 3, reorderedLines: 4 },
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: 'pdf-multicolumn-order-review' }),
    );
  });

  it('keeps stacked short glossary lines separate unless unwrapping is disabled', async () => {
    const makeDocument = () =>
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            'Alpha: first definition',
            'Beta: second definition',
            'Gamma: third definition',
            'Delta: fourth definition',
          ].map((text, index) =>
            span(text, 0.1, 0.2 + index * 0.025, {
              width: 0.12,
            }),
          ),
          links: [],
          images: [],
        },
      ]);
    const separated = await analysePdf(makeDocument(), {
      conversionDate: '2026-08-29',
    });
    const unwrapped = await analysePdf(makeDocument(), {
      conversionDate: '2026-08-29',
      unwrapFactor: 0,
    });
    const strict = await analysePdf(makeDocument(), {
      conversionDate: '2026-08-29',
      unwrapFactor: 1,
    });

    expect(
      separated.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(4);
    expect(
      unwrapped.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(1);
    expect(
      strict.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(4);
    expect(separated.model.warnings).toContainEqual(
      expect.objectContaining({
        code: 'pdf-line-reflow-summary',
        details: { joined: 0, kept: 3 },
      }),
    );
  });

  it('dehyphenates a line-end word only when body text provides evidence', async () => {
    const document = rawDocument([
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        spans: [
          span('The inter-', 0.1, 0.2, { width: 0.7 }),
          span('national market is changing.', 0.1, 0.225, { width: 0.7 }),
          span('International trade continues.', 0.1, 0.25, { width: 0.7 }),
        ],
        links: [],
        images: [],
      },
    ]);
    const unchanged = await analysePdf(document, {
      conversionDate: '2026-08-29',
    });
    const corrected = await analysePdf(document, {
      conversionDate: '2026-08-29',
      dehyphenate: true,
    });
    const correctedParagraph = corrected.model.blocks.find(
      (block) => block.type === 'paragraph',
    );

    expect(JSON.stringify(unchanged.model.blocks)).toContain('inter-');
    expect(correctedParagraph?.type).toBe('paragraph');
    if (correctedParagraph?.type === 'paragraph')
      expect(
        correctedParagraph.children
          .filter((node) => node.type === 'text')
          .map((node) => (node.type === 'text' ? node.text : ''))
          .join(''),
      ).toContain('The international market');
    expect(corrected.model.warnings).toContainEqual(
      expect.objectContaining({
        code: 'pdf-dehyphenation-summary',
        details: { joined: 1, kept: 0, limitExceeded: false },
      }),
    );
  });

  it('covers verse, glossary, and loose leading in generated PDFs', async () => {
    const options = { conversionDate: '2026-08-29' };
    const verse = await pdfJsReader.read(
      await fixture('reflow-verse.pdf'),
      options,
    );
    const glossary = await pdfJsReader.read(
      await fixture('reflow-glossary.pdf'),
      options,
    );
    const looseLeading = await pdfJsReader.read(
      await fixture('reflow-loose-leading.pdf'),
      { ...options, unwrapFactor: 0.4 },
    );

    expect(
      verse.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(4);
    expect(
      glossary.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(4);
    expect(
      glossary.model.blocks.some(
        (block) =>
          block.type === 'paragraph' && block.indent?.hanging !== undefined,
      ),
    ).toBe(true);
    expect(
      looseLeading.model.blocks.filter((block) => block.type === 'paragraph'),
    ).toHaveLength(1);
    expect(
      looseLeading.model.blocks.some(
        (block) => block.type === 'paragraph' && block.indent,
      ),
    ).toBe(false);
    expect(
      looseLeading.model.warnings.some(
        ({ code }) => code === 'pdf-paragraph-indents-normalized',
      ),
    ).toBe(false);
  });

  it('uses first-line indentation as a text-native paragraph boundary', async () => {
    const result = await pdfJsReader.read(
      await fixture('reflow-indented-paragraphs.pdf'),
      { conversionDate: '2026-08-29' },
    );
    const paragraphs = result.model.blocks.filter(
      (block) => block.type === 'paragraph',
    );

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).not.toHaveProperty('indent');
    expect(
      result.model.blocks.some((block) => block.type === 'blockquote'),
    ).toBe(false);
    expect(paragraphs[1]).toMatchObject({
      type: 'paragraph',
      indent: {
        firstLine: expect.any(Number),
        provenance: {
          source: 'pdf-layout-analysis',
          method: 'inferred',
        },
      },
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: 'pdf-paragraph-indents-normalized',
        severity: 'info',
        details: { paragraphs: 1 },
      }),
    );
  });

  it('keeps justified lines together while recognizing an indented next paragraph', async () => {
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('The justified paragraph begins', 0.1, 0.2, { width: 0.32 }),
            span('with a shorter left edge', 0.12, 0.23, { width: 0.3 }),
            span('and ends at the content edge.', 0.1, 0.26, { width: 0.22 }),
            span('The next paragraph starts indented.', 0.13, 0.29, {
              width: 0.25,
            }),
            span('Its continuation returns to the edge.', 0.1, 0.32, {
              width: 0.3,
            }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );
    const paragraphs = result.model.blocks.filter(
      (block) => block.type === 'paragraph',
    );

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toMatchObject({ type: 'paragraph' });
    expect(paragraphs[1]).toMatchObject({
      type: 'paragraph',
      indent: { firstLine: expect.any(Number) },
    });
  });

  it('proposes a blockquote only for repeated, uniform, quote-like indentation', async () => {
    const result = await pdfJsReader.read(
      await fixture('reflow-blockquote.pdf'),
      { conversionDate: '2026-08-29' },
    );

    expect(
      result.model.blocks.some((block) => block.type === 'blockquote'),
    ).toBe(true);
    expect(
      result.model.blocks.some(
        (block) => block.type === 'paragraph' && block.indent?.firstLine,
      ),
    ).toBe(false);
  });

  it('normalizes leading NBSP and ideographic-space runs without emitting them', async () => {
    const generated = await pdfJsReader.read(
      await fixture('reflow-nbsp-indent.pdf'),
      { conversionDate: '2026-08-29' },
    );
    const generatedParagraphs = generated.model.blocks.filter(
      (block) => block.type === 'paragraph',
    );
    const result = await analysePdf(
      rawDocument([
        {
          number: 1,
          width: 600,
          height: 800,
          rotation: 0,
          spans: [
            span('Baseline paragraph ends.', 0.1, 0.2, { width: 0.3 }),
            span('\u00a0\u00a0First NBSP indent.', 0.1, 0.23, { width: 0.3 }),
            span('\u3000Second ideographic indent.', 0.1, 0.26, {
              width: 0.3,
            }),
          ],
          links: [],
          images: [],
        },
      ]),
      { conversionDate: '2026-08-29' },
    );
    const paragraphs = result.model.blocks.filter(
      (block) => block.type === 'paragraph',
    );
    const text = JSON.stringify(paragraphs);

    expect(generatedParagraphs).toHaveLength(2);
    expect(generatedParagraphs[1]).toMatchObject({
      type: 'paragraph',
      indent: { firstLine: 0.03 },
    });
    expect(paragraphs).toHaveLength(3);
    expect(text).not.toContain('\u00a0');
    expect(text).not.toContain('\u3000');
    expect(paragraphs[1]).toMatchObject({
      type: 'paragraph',
      indent: { firstLine: 0.03 },
    });
    expect(paragraphs[2]).toMatchObject({
      type: 'paragraph',
      indent: { firstLine: 0.02 },
    });
  });
});
