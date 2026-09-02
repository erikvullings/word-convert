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
});

function lastPdfFormulaDecisions(worker: WorkerStub): unknown {
  const request = worker.postMessage.mock.calls.at(-1)?.[0] as
    { pdfOptions?: { formulaDecisions?: unknown } } | undefined;
  return request?.pdfOptions?.formulaDecisions;
}
