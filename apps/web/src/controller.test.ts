import m from 'mithril';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import { createBrowserController } from './controller.ts';
import type { WorkerResponse } from './worker/protocol.ts';
import type { PdfFormulaCandidate } from '@wordconvert/pdf-reader';

class WorkerStub {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private messageListener?: (event: MessageEvent<WorkerResponse>) => void;

  addEventListener(
    type: string,
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void {
    if (type === 'message') this.messageListener = listener;
  }

  emit(data: WorkerResponse): void {
    this.messageListener?.({ data } as MessageEvent<WorkerResponse>);
  }
}

function stubWorkers(...workers: WorkerStub[]): void {
  let index = 0;
  function WorkerConstructor() {
    return workers[index++] ?? workers.at(-1);
  }
  vi.stubGlobal('Worker', WorkerConstructor);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function model(): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-09-01',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks: [],
    assets: {},
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}

function formulaCandidate(id = 'pdf-equation-p2-001'): PdfFormulaCandidate {
  return {
    id,
    page: 2,
    kind: 'display',
    bounds: { x: 0.2, top: 0.3, width: 0.4, height: 0.08 },
    spanIds: ['formula-span'],
    features: {
      mathFontRatio: 1,
      operatorRatio: 0.2,
      greekRatio: 0,
      symbolRatio: 0.2,
      singleLetterTokenRatio: 0.5,
      dictionaryLikeWordRatio: 0,
      superscriptCount: 0,
      subscriptCount: 0,
      baselineVariance: 0,
      fontSizeVariance: 0,
      centered: true,
      isolated: true,
      equationNumberAtRight: false,
      multilineStructure: false,
      score: 5,
      confidence: 'high',
    },
    score: 5,
    confidence: 'high',
    sources: ['heron'],
    tex: 'x^2',
    requiresRecognition: false,
  };
}

describe('browser controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports a selected file that the browser cannot read', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    const unreadable = {
      name: 'unreadable.pdf',
      type: 'application/pdf',
      size: 1,
      arrayBuffer: () =>
        Promise.reject(new DOMException('', 'NotReadableError')),
    } as File;

    controller.selectFiles([unreadable]);
    await vi.waitFor(() => expect(controller.state.status).toBe('error'));

    expect(controller.state.error).toMatchObject({
      code: 'invalid-input',
      message: 'The selected file could not be read.',
      recoverable: true,
    });
    expect(controller.state.progress).toBeUndefined();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('opens remote Markdown without invoking document analysis', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response('# Remote heading', {
            headers: {
              'content-type': 'text/markdown',
              'content-disposition': 'inline; filename="remote.md"',
            },
          }),
        ),
      ),
    );
    const controller = createBrowserController();

    controller.setRemoteDocumentUrl?.('https://example.com/remote.md');
    controller.loadRemoteDocument?.();
    await vi.waitFor(() => expect(controller.state.status).toBe('ready'));

    expect(controller.state).toMatchObject({
      stage: 1,
      sourceFormat: 'markdown',
      selectedFilename: 'remote.md',
      model: {
        blocks: [{ type: 'heading', level: 1 }],
      },
    });
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('cancels before a selected file has finished reading', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const read = deferred<ArrayBuffer>();
    const controller = createBrowserController();
    const pending = {
      name: 'pending.pdf',
      type: 'application/pdf',
      size: 1,
      arrayBuffer: () => read.promise,
    } as File;

    controller.selectFiles([pending]);
    const operationId = controller.state.operationId;
    controller.cancel();
    read.resolve(new ArrayBuffer(1));
    await Promise.resolve();

    expect(controller.state).toMatchObject({ stage: 0, status: 'idle' });
    expect(controller.state.operationId).toBeUndefined();
    expect(controller.state.progress).toBeUndefined();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'cancel',
      operationId,
    });
  });

  it('terminates the worker and ignores pending reads when disposed', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const read = deferred<ArrayBuffer>();
    const controller = createBrowserController();
    const pending = {
      name: 'pending.pdf',
      type: 'application/pdf',
      size: 1,
      arrayBuffer: () => read.promise,
    } as File;

    controller.selectFiles([pending]);
    controller.dispose?.();
    read.resolve(new ArrayBuffer(1));
    await Promise.resolve();

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('replaces a busy worker before opening another file', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const firstWorker = new WorkerStub();
    const replacementWorker = new WorkerStub();
    stubWorkers(firstWorker, replacementWorker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    const firstFile = new File([new Uint8Array([1])], 'first.pdf', {
      type: 'application/pdf',
    });
    const secondFile = new File([new Uint8Array([2])], 'second.pdf', {
      type: 'application/pdf',
    });

    controller.selectFiles([firstFile]);
    await vi.waitFor(() =>
      expect(firstWorker.postMessage).toHaveBeenCalledOnce(),
    );
    controller.selectFiles([secondFile]);
    await vi.waitFor(() =>
      expect(replacementWorker.postMessage).toHaveBeenCalledOnce(),
    );

    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(replacementWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'analyse', filename: 'second.pdf' }),
      expect.any(Array),
    );
  });

  it('replaces a worker that is preparing PDF layout detection', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const firstWorker = new WorkerStub();
    const replacementWorker = new WorkerStub();
    stubWorkers(firstWorker, replacementWorker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    const firstFile = new File([new Uint8Array([1])], 'first.pdf', {
      type: 'application/pdf',
    });
    const secondFile = new File([new Uint8Array([2])], 'second.pdf', {
      type: 'application/pdf',
    });

    controller.selectFiles([firstFile]);
    await vi.waitFor(() =>
      expect(firstWorker.postMessage).toHaveBeenCalledOnce(),
    );
    const operationId = controller.state.operationId;
    if (!operationId) throw new Error('Analysis operation was not started.');
    firstWorker.emit({
      type: 'analysed',
      operationId,
      model: model(),
      pdfAnalysis: {
        pageCount: 44,
        analysedPages: [1, 12, 23, 33, 44],
        crop: { top: 0, bottom: 0 },
        scannedPages: [],
        candidates: [],
      },
    });
    expect(controller.state.pdfLayoutStatus).toBe('loading');

    controller.selectFiles([secondFile]);
    await vi.waitFor(() =>
      expect(replacementWorker.postMessage).toHaveBeenCalledOnce(),
    );

    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(replacementWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'analyse', filename: 'second.pdf' }),
      expect.any(Array),
    );
  });

  it('guards an unsaved output before resetting to a fresh home state', () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    const replacementWorker = new WorkerStub();
    stubWorkers(worker, replacementWorker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const controller = createBrowserController();
    controller.state.stage = 2;
    controller.state.selectedFilename = 'report.pdf';
    controller.state.output = {
      filename: 'report.epub',
      mediaType: 'application/epub+zip',
      data: new ArrayBuffer(1),
    };
    controller.state.outputSaved = false;

    controller.reset();

    expect(confirm).toHaveBeenCalledOnce();
    expect(controller.state.stage).toBe(2);
    expect(controller.state.output?.filename).toBe('report.epub');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('resets downloaded output without prompting and preserves preferences', () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    const replacementWorker = new WorkerStub();
    stubWorkers(worker, replacementWorker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const controller = createBrowserController();
    controller.state.preferences.theme = 'dark';
    controller.state.stage = 2;
    controller.state.selectedFilename = 'report.pdf';
    controller.state.output = {
      filename: 'report.epub',
      mediaType: 'application/epub+zip',
      data: new ArrayBuffer(1),
    };
    controller.state.outputSaved = true;

    controller.reset();

    expect(confirm).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({
      stage: 0,
      status: 'idle',
      preferences: expect.objectContaining({ theme: 'dark' }),
    });
    expect(controller.state.output).toBeUndefined();
    expect(controller.state.selectedFilename).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('normalizes a custom output filename while retaining its extension', () => {
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.state.output = {
      filename: 'report.epub',
      mediaType: 'application/epub+zip',
      data: new ArrayBuffer(1),
    };

    controller.setOutputFilename('../ Final handbook ');

    expect(controller.state.output.filename).toBe('Final handbook.epub');

    controller.setOutputFilename('Final handbook.epub');

    expect(controller.state.output.filename).toBe('Final handbook.epub');
  });

  it('mails the ready EPUB using its document metadata title', async () => {
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const share = vi.fn<(data: ShareData) => Promise<void>>(
      async () => undefined,
    );
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share,
    });
    const controller = createBrowserController();
    controller.state.model = model();
    controller.state.model.metadata.title = {
      value: 'Attention Is All You Need [1706.03762]',
      provenance: {
        source: 'https://arxiv.org/html/1706.03762v7',
        method: 'extracted',
        confidence: 'high',
      },
    };
    controller.state.output = {
      filename: '1706.03762v7.epub',
      mediaType: 'application/epub+zip',
      data: new ArrayBuffer(1),
    };

    controller.mailDocument?.();
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce());

    expect(share.mock.calls[0]?.[0]).toMatchObject({
      title: 'Attention Is All You Need [1706.03762]',
      files: [expect.objectContaining({ name: '1706.03762v7.epub' })],
    });
  });

  it('uses the enriched arXiv title as the EPUB output filename', () => {
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.state.sourceFormat = 'html';
    controller.state.selectedFilename = '1706.03762v7.html';
    controller.state.preferences.outputFormat = 'epub';
    controller.state.model = model();
    controller.state.model.metadata.title = {
      value: 'Attention Is All You Need [1706.03762]',
      provenance: {
        source: 'https://arxiv.org/html/1706.03762v7',
        method: 'extracted',
        confidence: 'high',
      },
    };
    controller.state.model.metadata.identifier = {
      value: 'https://arxiv.org/html/1706.03762v7',
      provenance: {
        source: 'https://arxiv.org/html/1706.03762v7',
        method: 'extracted',
        confidence: 'high',
      },
    };

    controller.convert();

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'convert',
        filename: 'Attention Is All You Need [1706.03762].epub',
      }),
    );
  });

  it('retains formula decisions across PDF reruns and prunes disappeared candidates', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.selectFiles([
      new File([new Uint8Array([1])], 'formulas.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const initialOperationId = controller.state.operationId;
    if (!initialOperationId)
      throw new Error('Initial analysis was not started.');
    worker.emit({
      type: 'analysed',
      operationId: initialOperationId,
      model: model(),
      pdfAnalysis: {
        pageCount: 2,
        analysedPages: [1, 2],
        crop: { top: 0, bottom: 0 },
        scannedPages: [],
        candidates: [],
        formulaCandidates: [formulaCandidate()],
      },
    });

    controller.setFormulaDecision?.({
      equationId: 'pdf-equation-p2-001',
      decision: 'formula',
      tex: 'x^3',
    });
    controller.rerunAnalysis();

    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'analyse',
        pdfOptions: expect.objectContaining({
          formulaDecisions: {
            'pdf-equation-p2-001': {
              equationId: 'pdf-equation-p2-001',
              decision: 'formula',
              tex: 'x^3',
            },
          },
        }),
      }),
      expect.any(Array),
    );
    const rerunOperationId = controller.state.operationId;
    if (!rerunOperationId) throw new Error('Rerun analysis was not started.');
    controller.state.formulaDrafts['pdf-equation-p2-001'] = 'x^4';
    controller.state.formulaValidationErrors['pdf-equation-p2-001'] =
      'stale error';
    controller.state.formulaReviewSelectedId = 'pdf-equation-p2-001';
    worker.emit({
      type: 'analysed',
      operationId: rerunOperationId,
      model: model(),
      pdfAnalysis: {
        pageCount: 2,
        analysedPages: [1],
        crop: { top: 0, bottom: 0 },
        scannedPages: [],
        candidates: [],
        formulaCandidates: [],
      },
    });

    expect(controller.state.pdfImport.formulaDecisions).toHaveProperty(
      'pdf-equation-p2-001',
    );
    expect(controller.state.formulaDrafts).toHaveProperty(
      'pdf-equation-p2-001',
    );
    expect(controller.state.formulaReviewSelectedId).toBe(
      'pdf-equation-p2-001',
    );

    controller.rerunAnalysis();
    const completeRerunOperationId = controller.state.operationId;
    if (!completeRerunOperationId)
      throw new Error('Complete rerun analysis was not started.');
    worker.emit({
      type: 'analysed',
      operationId: completeRerunOperationId,
      model: model(),
      pdfAnalysis: {
        pageCount: 2,
        analysedPages: [1, 2],
        crop: { top: 0, bottom: 0 },
        scannedPages: [],
        candidates: [],
        formulaCandidates: [],
      },
    });

    expect(controller.state.pdfImport.formulaDecisions).toEqual({});
    expect(controller.state.formulaDrafts).toEqual({});
    expect(controller.state.formulaValidationErrors).toEqual({});
    expect(controller.state.formulaReviewSelectedId).toBeUndefined();
  });

  it('validates and reruns formula edit, reset, reject, and bulk accept commands', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.selectFiles([
      new File([new Uint8Array([1])], 'formulas.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const high = formulaCandidate('high');
    const low = { ...formulaCandidate('low'), confidence: 'low' as const };
    low.features = { ...low.features, confidence: 'low' };
    const analysedModel = model();
    analysedModel.equations = {
      high: {
        id: 'high',
        source: { format: 'tex', value: 'x' },
        tex: 'x',
        conversionComplete: true,
        review: { status: 'unreviewed' },
      },
      low: {
        id: 'low',
        source: { format: 'tex', value: 'y' },
        tex: 'y',
        conversionComplete: true,
        review: { status: 'unreviewed' },
      },
    };
    const emitAnalysis = () => {
      const operationId = controller.state.operationId;
      if (!operationId) throw new Error('Analysis was not started.');
      worker.emit({
        type: 'analysed',
        operationId,
        model: analysedModel,
        pdfAnalysis: {
          pageCount: 2,
          analysedPages: [1, 2],
          crop: { top: 0, bottom: 0 },
          scannedPages: [],
          candidates: [],
          formulaCandidates: [high, low],
        },
      });
    };
    emitAnalysis();

    controller.setFormulaDraft?.('high', '\\frac{x{y}');
    controller.saveFormulaEdit?.('high');
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(controller.state.formulaValidationErrors.high).toBe(
      'Enter valid LaTeX before saving.',
    );

    delete controller.state.formulaDrafts.high;
    controller.saveFormulaEdit?.('high');
    expect(lastPdfFormulaDecisions(worker)).toMatchObject({
      high: { decision: 'formula', tex: 'x' },
    });
    emitAnalysis();

    controller.setFormulaDraft?.('high', 'x^3');
    controller.saveFormulaEdit?.('high');
    expect(lastPdfFormulaDecisions(worker)).toMatchObject({
      high: { decision: 'formula', tex: 'x^3' },
    });
    emitAnalysis();

    controller.setFormulaDraft?.('high', 'x\\tag{1}');
    controller.saveFormulaEdit?.('high');
    expect(lastPdfFormulaDecisions(worker)).toMatchObject({
      high: { decision: 'formula', tex: 'x\\tag{1}' },
    });
    emitAnalysis();

    controller.setFormulaDraft?.('high', 'a &= b\nc &= d');
    controller.saveFormulaEdit?.('high');
    expect(lastPdfFormulaDecisions(worker)).toMatchObject({
      high: {
        decision: 'formula',
        tex: '\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',
      },
    });
    emitAnalysis();

    controller.resetFormulaEdit?.('high');
    expect(lastPdfFormulaDecisions(worker)).toEqual({});
    emitAnalysis();

    controller.rejectFormula?.('high');
    expect(lastPdfFormulaDecisions(worker)).toMatchObject({
      high: { decision: 'text' },
    });
    emitAnalysis();

    controller.resetFormulaEdit?.('high');
    emitAnalysis();
    controller.acceptHighConfidenceFormulas?.();
    expect(lastPdfFormulaDecisions(worker)).toEqual({
      high: {
        equationId: 'high',
        decision: 'formula',
        accepted: true,
      },
    });
  });

  it('creates, persists, rejects, and removes a manual formula region', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.selectFiles([
      new File([new Uint8Array([1])], 'manual-formula.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    controller.state.pdfPreviewPage = 2;
    controller.setFormulaSelectionKind?.('display');
    controller.setFormulaSelectionBounds?.({
      x: 0.1,
      top: 0.2,
      width: 0.3,
      height: 0.1,
    });
    controller.addManualFormulaRegion?.();

    const id = 'pdf-equation-manual-p2-1000-2000-3000-1000';
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [
        {
          id,
          page: 2,
          kind: 'display',
          bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
        },
      ],
      formulaDecisions: {
        [id]: { equationId: id, decision: 'formula' },
      },
    });

    controller.rejectFormula?.(id);
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [expect.objectContaining({ id })],
      formulaDecisions: { [id]: { equationId: id, decision: 'text' } },
    });

    controller.removeManualFormulaRegion?.(id);
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [],
      formulaDecisions: {},
    });
  });

  it('keeps a detected image or promotes it to TexTeller recognition', async () => {
    vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
    const worker = new WorkerStub();
    stubWorkers(worker);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
    });
    const controller = createBrowserController();
    controller.selectFiles([
      new File([new Uint8Array([1])], 'image-formula.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const image = {
      id: 'pdf-equation-2-0',
      page: 2,
      bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
    };
    controller.state.pdfAnalysis = {
      pageCount: 2,
      analysedPages: [1, 2],
      crop: { top: 0, bottom: 0 },
      candidates: [],
      scannedPages: [],
      formulaCandidates: [],
      formulaImageRegions: [image],
    };

    controller.keepFormulaImage?.(image.id);
    expect(controller.state.pdfImport.formulaDecisions[image.id]).toEqual({
      equationId: image.id,
      decision: 'image',
      accepted: true,
    });
    expect(worker.postMessage).toHaveBeenCalledTimes(2);

    controller.processFormulaImage?.(image.id);
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [
        {
          id: image.id,
          page: 2,
          kind: 'display',
          forceRecognition: true,
          sourceImageId: image.id,
          bounds: image.bounds,
        },
      ],
      formulaDecisions: {
        [image.id]: { equationId: image.id, decision: 'formula' },
      },
    });
    expect(controller.state.formulaReviewSelectedId).toBe(image.id);

    worker.emit({
      type: 'analysed',
      operationId: controller.state.operationId!,
      model: model(),
      pdfAnalysis: {
        pageCount: 2,
        analysedPages: [1, 2],
        crop: { top: 0, bottom: 0 },
        candidates: [],
        scannedPages: [],
        formulaCandidates: [
          {
            ...formulaCandidate(image.id),
            sourceImageId: image.id,
            requiresRecognition: true,
            recognitionFailure: 'invalid-tex',
          },
        ],
        formulaImageRegions: [image],
      },
    });
    expect(controller.state.formulaExtractionMessage).toContain(
      'TexTeller could not extract this region (invalid-tex)',
    );

    controller.adjustFormulaImageRegion?.(image.id);
    expect(controller.state).toMatchObject({
      formulaSelectionOpen: true,
      formulaSelectionKind: 'display',
      formulaSelectionBounds: image.bounds,
      pdfPreviewPage: 2,
    });
    controller.setFormulaSelectionBounds?.({
      x: 0.12,
      top: 0.22,
      width: 0.5,
      height: 0.12,
    });
    controller.setFormulaSelectionTex?.('\\sqrt{d_{k}}');
    controller.addManualFormulaRegion?.('\\sqrt{d_{k}}');
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [
        {
          id: image.id,
          page: 2,
          kind: 'display',
          skipRecognition: true,
          sourceImageId: image.id,
          bounds: { x: 0.12, top: 0.22, width: 0.5, height: 0.12 },
        },
      ],
      formulaDecisions: {
        [image.id]: {
          equationId: image.id,
          decision: 'formula',
          tex: '\\sqrt{d_{k}}',
          display: 'block',
        },
      },
    });
    expect(controller.state.formulaExtractionId).toBeUndefined();

    controller.state.pdfAnalysis.formulaImageRegions = [image];
    controller.saveFormulaImage?.(image.id, 'x^2');
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [
        expect.objectContaining({
          id: image.id,
          bounds: image.bounds,
          skipRecognition: true,
          sourceImageId: image.id,
        }),
      ],
      formulaDecisions: {
        [image.id]: expect.objectContaining({ tex: 'x^2', display: 'block' }),
      },
    });

    controller.keepFormulaImage?.(image.id);
    expect(lastPdfOptions(worker)).toMatchObject({
      manualFormulaRegions: [],
      formulaDecisions: {
        [image.id]: {
          equationId: image.id,
          decision: 'image',
          accepted: true,
        },
      },
    });
  });
});

function lastPdfFormulaDecisions(worker: WorkerStub): unknown {
  const request = worker.postMessage.mock.calls.at(-1)?.[0] as
    { pdfOptions?: { formulaDecisions?: unknown } } | undefined;
  return request?.pdfOptions?.formulaDecisions;
}

function lastPdfOptions(worker: WorkerStub): unknown {
  const request = worker.postMessage.mock.calls.at(-1)?.[0] as
    { pdfOptions?: unknown } | undefined;
  return request?.pdfOptions;
}
