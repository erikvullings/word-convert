import m from 'mithril';
import type { Person, StyleMapping } from '@wordconvert/document-model';

import type { AppController } from './app.ts';
import {
  acceptHighConfidenceMappings,
  addAuthor,
  exportStylePreset,
  importStylePreset,
  parseAuthors,
  removeAuthor,
  setAuthors,
  setMetadataField,
  setSubjects,
  updateAuthor,
  type EditableMetadataField,
} from './editors.ts';
import {
  createInitialState,
  loadPreferences,
  persistPreferences,
  validateSourceFile,
  type AppState,
  type ThemePreference,
} from './state.ts';
import type { WorkerRequest, WorkerResponse } from './worker/protocol.ts';
import {
  coverComposition,
  validateCoverFile,
  type CoverSettings,
  type CoverSource,
} from './cover.ts';
import {
  prepareCoverImage,
  titleTextWarning,
} from '@wordconvert/cover-generator';
import { saveDownload } from './download/index.ts';
import { withMarkdownContent } from './content-editor.ts';
import { fetchRemotePdf } from './remote-pdf.ts';
import { inferDocumentLanguage } from './language.ts';
import { isValidTex } from '@wordconvert/math-converter';

export function createBrowserController(): AppController {
  const state: AppState = createInitialState(
    new Date().toLocaleDateString('en-CA'),
    loadPreferences(localStorage),
  );
  let worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
    type: 'module',
  });
  let sourceInput: ArrayBuffer | undefined;
  let sourceFilename: string | undefined;
  let autoPreviewOperationId: string | undefined;
  let pdfLayoutOperationId: string | undefined;
  let epubRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let remotePdfAbort: AbortController | undefined;
  let previewRenderer:
    import('./pdf-preview.ts').PdfPagePreviewRenderer | undefined;
  let pendingPdfPreviewPage: number | undefined;
  let pdfPreviewRendering = false;
  let disposed = false;
  const releasePdfPreview = (): void => {
    if (state.pdfPreview) URL.revokeObjectURL(state.pdfPreview.url);
    delete state.pdfPreview;
  };
  const disposePdfPreview = (): void => {
    pendingPdfPreviewPage = undefined;
    state.pdfPreviewLoading = false;
    delete state.pdfPreviewOperationId;
    releasePdfPreview();
    void previewRenderer?.dispose();
    previewRenderer = undefined;
  };
  const renderPendingPdfPage = async (): Promise<void> => {
    if (
      pdfPreviewRendering ||
      pendingPdfPreviewPage === undefined ||
      !sourceInput
    )
      return;
    const pageNumber = pendingPdfPreviewPage;
    pendingPdfPreviewPage = undefined;
    const input = sourceInput;
    const previewOperationId = state.pdfPreviewOperationId;
    pdfPreviewRendering = true;
    void import('./pdf-preview.ts')
      .then(async ({ createPdfPagePreviewRenderer }) => {
        previewRenderer ??= createPdfPagePreviewRenderer();
        const preview = await previewRenderer.render(input, pageNumber);
        if (state.pdfPreviewOperationId !== previewOperationId) return;
        releasePdfPreview();
        state.pdfPreview = {
          pageNumber: preview.pageNumber,
          width: preview.width,
          height: preview.height,
          url: URL.createObjectURL(preview.blob),
        };
        state.pdfPreviewLoading = false;
        delete state.pdfPreviewError;
        delete state.pdfPreviewOperationId;
        m.redraw();
      })
      .catch((cause: unknown) => {
        if (state.pdfPreviewOperationId !== previewOperationId) return;
        state.pdfPreviewLoading = false;
        state.pdfPreviewError =
          cause instanceof Error
            ? cause.message
            : 'The PDF page preview could not be rendered.';
        delete state.pdfPreviewOperationId;
        m.redraw();
      })
      .finally(() => {
        pdfPreviewRendering = false;
        if (pendingPdfPreviewPage !== undefined) void renderPendingPdfPage();
      });
  };
  const requestPdfPage = (requestedPage: number): void => {
    if (!sourceInput || state.sourceFormat !== 'pdf') return;
    const pageCount = state.pdfAnalysis?.pageCount ?? 1;
    const pageNumber = Math.min(
      pageCount,
      Math.max(1, Math.round(requestedPage)),
    );
    state.pdfPreviewPage = pageNumber;
    state.pdfPreviewRequested = true;
    state.pdfOriginalVisible = true;
    state.pdfPreviewLoading = true;
    delete state.pdfPreviewError;
    state.pdfPreviewOperationId = operationId('pdf-preview');
    pendingPdfPreviewPage = pageNumber;
    void renderPendingPdfPage();
  };
  const requestConvert = (): void => {
    if (!state.model) return;
    if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
    epubRefreshTimer = undefined;
    delete state.markdownEdit;
    state.outputSaved = false;
    state.status = 'converting';
    state.operationId = operationId('convert');
    const metadata = state.model.metadata;
    const cover = coverComposition(state.cover, {
      title: metadata.title?.value ?? 'Untitled',
      ...(metadata.subtitle?.value
        ? { subtitle: metadata.subtitle.value }
        : {}),
      authors: metadata.authors.map(({ value }) => value.name),
    });
    worker.postMessage({
      type: 'convert',
      operationId: state.operationId,
      model:
        state.preferences.outputFormat === 'epub' &&
        state.epubContentEdit !== undefined
          ? withMarkdownContent(state.model, state.epubContentEdit)
          : state.model,
      filename: sourceFilename ?? state.selectedFilename ?? 'document.docx',
      format: state.preferences.outputFormat,
      conversionDate: state.conversionDate,
      formulaMode: state.preferences.formulaMode,
      mode:
        state.preferences.outputFormat === 'html'
          ? state.preferences.htmlMode
          : state.preferences.outputFormat === 'markdown'
            ? state.preferences.markdownMode
            : 'epub',
      ...(cover && state.preferences.epubIncludeCover ? { cover } : {}),
    } satisfies WorkerRequest);
  };
  const refreshEpubPreview = (): void => {
    if (state.preferences.outputFormat !== 'epub') return;
    if (state.stage !== 2) return;
    if (epubMetadataIssues(state)) {
      delete state.output;
      state.status = 'ready';
      return;
    }
    requestConvert();
  };

  const handlePopState = (event: PopStateEvent): void => {
    if (!state.model) {
      state.stage = 0;
      delete state.review;
      m.redraw();
      return;
    }
    const stage =
      typeof event.state?.stage === 'number' ? event.state.stage : 1;
    state.review = ['styles', 'metadata', 'formula'].includes(
      event.state?.review,
    )
      ? event.state.review
      : undefined;
    if (stage === 1) {
      state.stage = 1;
      delete state.output;
      delete state.markdownEdit;
    } else {
      state.stage = 2;
    }
    m.redraw();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', disposePdfPreview, { once: true });
    window.addEventListener('popstate', handlePopState);
  }

  const handleWorkerMessage = (event: MessageEvent<WorkerResponse>): void => {
    if (disposed) return;
    if (
      event.data.type === 'pdf-layout-status' &&
      event.data.operationId === pdfLayoutOperationId
    ) {
      state.pdfLayoutStatus = event.data.status;
      if (event.data.status !== 'loading') pdfLayoutOperationId = undefined;
      m.redraw();
      return;
    }
    const shouldAutoPreview =
      event.data.type === 'analysed' &&
      event.data.operationId === autoPreviewOperationId;
    applyResponse(state, event.data);
    if (
      event.data.type === 'analysed' &&
      event.data.pdfAnalysis &&
      event.data.pdfAnalysis.analysedPages.length <
        event.data.pdfAnalysis.pageCount &&
      !pdfLayoutOperationId &&
      state.pdfLayoutStatus !== 'ready'
    ) {
      pdfLayoutOperationId = operationId('prepare-pdf-layout');
      state.pdfLayoutStatus = 'loading';
      worker.postMessage({
        type: 'prepare-pdf-layout',
        operationId: pdfLayoutOperationId,
      } satisfies WorkerRequest);
    }
    if (shouldAutoPreview) {
      autoPreviewOperationId = undefined;
      requestPdfPage(1);
    } else if (
      event.data.operationId === autoPreviewOperationId &&
      event.data.type === 'error'
    ) {
      autoPreviewOperationId = undefined;
    }
    m.redraw();
  };
  const handleWorkerError = (): void => {
    if (disposed) return;
    state.error = {
      code: 'conversion-failed',
      message: 'The background conversion worker could not be started.',
      recoverable: true,
    };
    state.status = 'error';
    delete state.progress;
    m.redraw();
  };
  const attachWorker = (target: Worker): void => {
    target.addEventListener('message', handleWorkerMessage);
    target.addEventListener('error', handleWorkerError);
  };
  const replaceWorker = (): void => {
    // ONNX session creation can block the worker before it observes cancellation.
    worker.terminate();
    worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
      type: 'module',
    });
    attachWorker(worker);
  };
  attachWorker(worker);

  const controller: AppController = {
    state,
    dispose() {
      if (disposed) return;
      disposed = true;
      remotePdfAbort?.abort();
      remotePdfAbort = undefined;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      disposePdfPreview();
      worker.terminate();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', disposePdfPreview);
        window.removeEventListener('popstate', handlePopState);
      }
    },
    reset() {
      if (
        state.outputSaved === false &&
        !confirm(
          'This document has changes that have not been downloaded. Discard everything and return home?',
        )
      )
        return;
      remotePdfAbort?.abort();
      remotePdfAbort = undefined;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      disposePdfPreview();
      replaceWorker();
      sourceInput = undefined;
      sourceFilename = undefined;
      autoPreviewOperationId = undefined;
      pdfLayoutOperationId = undefined;
      const freshState = createInitialState(
        state.conversionDate,
        state.preferences,
      );
      for (const key of Object.keys(state)) Reflect.deleteProperty(state, key);
      Object.assign(state, freshState);
      if (typeof history !== 'undefined')
        history.replaceState({ stage: 0 }, '', window.location.href);
      m.redraw();
    },
    selectFiles(files) {
      const file = files[0];
      if (!file) return;
      if (
        pdfLayoutOperationId ||
        state.status === 'analysing' ||
        state.status === 'converting'
      ) {
        replaceWorker();
        pdfLayoutOperationId = undefined;
      }
      remotePdfAbort?.abort();
      remotePdfAbort = undefined;
      delete state.remotePdfLoading;
      const validation = validateSourceFile(file);
      if (validation) {
        state.error = {
          code: 'invalid-input',
          message: validation,
          recoverable: true,
        };
        state.status = 'error';
        return;
      }
      delete state.error;
      delete state.output;
      state.outputSaved = false;
      delete state.selectedEpubFile;
      delete state.epubContentEdit;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      delete state.model;
      delete state.pdfAnalysis;
      state.pdfImport.formulaDecisions = {};
      state.formulaDrafts = {};
      state.formulaValidationErrors = {};
      delete state.formulaReviewSelectedId;
      delete state.pdfLayoutStatus;
      disposePdfPreview();
      state.pdfPreviewPage = 1;
      state.pdfPreviewScale = 1;
      delete state.pdfPreviewRequested;
      delete state.pdfOriginalVisible;
      delete state.pdfPreviewError;
      delete state.pdfPreviewOperationId;
      state.selectedFilename = file.name;
      const sourceFormat = file.name.toLowerCase().endsWith('.pdf')
        ? 'pdf'
        : 'docx';
      state.sourceFormat = sourceFormat;
      state.stage = 1;
      state.status = 'analysing';
      state.progress = {
        phase: 'inspect',
        completed: 0,
        total: 0,
        message:
          sourceFormat === 'pdf' ? 'Opening PDF…' : 'Opening Word document…',
      };
      state.operationId = operationId('analyse');
      const analyseOperationId = state.operationId;
      autoPreviewOperationId =
        sourceFormat === 'pdf' ? analyseOperationId : undefined;
      void file
        .arrayBuffer()
        .then((input) => {
          if (disposed || state.operationId !== analyseOperationId) return;
          sourceInput = input;
          sourceFilename = file.name;
          const request = {
            type: 'analyse',
            operationId: analyseOperationId,
            input: input.slice(0),
            filename: file.name,
            sourceFormat,
            conversionDate: state.conversionDate,
            ...(sourceFormat === 'pdf'
              ? {
                  pdfOptions: pdfWorkerOptions(
                    state,
                    state.pdfImport.samplePageCount,
                  ),
                }
              : {}),
          } satisfies WorkerRequest;
          worker.postMessage(request, [request.input]);
        })
        .catch(() => {
          if (disposed || state.operationId !== analyseOperationId) return;
          state.error = {
            code: 'invalid-input',
            message: 'The selected file could not be read.',
            recoverable: true,
          };
          state.status = 'error';
          delete state.progress;
          m.redraw();
        });
    },
    cancel() {
      remotePdfAbort?.abort();
      remotePdfAbort = undefined;
      delete state.remotePdfLoading;
      if (!state.operationId) return;
      const cancelledOperationId = state.operationId;
      worker.postMessage({
        type: 'cancel',
        operationId: cancelledOperationId,
      } satisfies WorkerRequest);
      delete state.operationId;
      delete state.progress;
      if (state.model) {
        state.status = 'ready';
        state.stage = 1;
      } else {
        state.status = 'idle';
        state.stage = 0;
        delete state.selectedFilename;
        delete state.sourceFormat;
        delete state.outputSaved;
      }
      m.redraw();
    },
    setRemotePdfUrl(url) {
      state.remotePdfUrl = url;
      if (state.stage === 0) delete state.error;
    },
    loadRemotePdf() {
      const url = state.remotePdfUrl.trim();
      if (!url || state.remotePdfLoading) return;
      remotePdfAbort?.abort();
      const abort = new AbortController();
      remotePdfAbort = abort;
      state.remotePdfLoading = true;
      delete state.error;
      void fetchRemotePdf(url, fetch, abort.signal)
        .then((file) => {
          if (remotePdfAbort !== abort) return;
          remotePdfAbort = undefined;
          delete state.remotePdfLoading;
          controller.selectFiles([file]);
          m.redraw();
        })
        .catch((cause: unknown) => {
          if (remotePdfAbort !== abort) return;
          remotePdfAbort = undefined;
          delete state.remotePdfLoading;
          if (abort.signal.aborted) return;
          state.error = {
            code: 'invalid-input',
            message:
              cause instanceof Error
                ? cause.message
                : 'The remote PDF could not be loaded.',
            recoverable: true,
          };
          state.status = 'error';
          m.redraw();
        });
    },
    convert() {
      requestConvert();
    },
    download() {
      if (!state.output) return;
      const output =
        state.markdownEdit !== undefined &&
        state.preferences.outputFormat === 'markdown' &&
        state.preferences.markdownMode === 'single'
          ? {
              ...state.output,
              data: new TextEncoder().encode(state.markdownEdit)
                .buffer as ArrayBuffer,
            }
          : state.output;
      void saveDownload(
        output,
        {
          createObjectURL: (blob) => URL.createObjectURL(blob),
          revokeObjectURL: (url) => URL.revokeObjectURL(url),
          createAnchor: () => document.createElement('a'),
          ...('showSaveFilePicker' in window
            ? {
                showSaveFilePicker: (options: unknown) =>
                  (
                    window as unknown as {
                      showSaveFilePicker: (
                        pickerOptions: unknown,
                      ) => Promise<never>;
                    }
                  ).showSaveFilePicker(options),
              }
            : {}),
        },
        () => {
          if (state.preferences.outputFormat !== 'epub') delete state.output;
          delete state.markdownEdit;
        },
      )
        .then((saved) => {
          if (saved) state.outputSaved = true;
          m.redraw();
        })
        .catch(() => {
          state.error = {
            code: 'conversion-failed',
            message: 'The converted document could not be saved.',
            recoverable: true,
          };
          state.status = 'error';
          m.redraw();
        });
    },
    setOutputFilename(filename) {
      if (!state.output) return;
      state.output = {
        ...state.output,
        filename: normalizeOutputFilename(filename, state.output.filename),
      };
      state.outputSaved = false;
    },
    setMarkdownContent(content) {
      state.markdownEdit = content;
      state.outputSaved = false;
    },
    setTheme(theme: ThemePreference) {
      state.preferences.theme = theme;
      persistPreferences(localStorage, state.preferences);
      document.documentElement.dataset.theme = theme;
    },
    setOutputFormat(format) {
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      state.preferences.outputFormat = format;
      persistPreferences(localStorage, state.preferences);
      delete state.output;
      delete state.selectedEpubFile;
      state.stage = 2;
      if (typeof history !== 'undefined')
        history.pushState({ stage: 2, format }, '', window.location.href);
      if (format !== 'epub' || !epubMetadataIssues(state)) requestConvert();
    },
    setFormulaMode(mode) {
      state.preferences.formulaMode = mode;
      persistPreferences(localStorage, state.preferences);
      delete state.output;
      if (state.stage === 2) requestConvert();
    },
    setHtmlMode(mode) {
      state.preferences.htmlMode = mode;
      state.preferences.assetMode = mode === 'zip' ? 'folder' : 'embedded';
      persistPreferences(localStorage, state.preferences);
      if (state.stage === 2) requestConvert();
    },
    setMarkdownMode(mode) {
      state.preferences.markdownMode = mode;
      state.preferences.assetMode = mode === 'zip' ? 'folder' : 'embedded';
      persistPreferences(localStorage, state.preferences);
      if (state.stage === 2) requestConvert();
    },
    setEpubIncludeCover(include) {
      state.preferences.epubIncludeCover = include;
      persistPreferences(localStorage, state.preferences);
      refreshEpubPreview();
    },
    setEpubContent(content) {
      state.epubContentEdit = content;
      state.outputSaved = false;
      if (state.preferences.outputFormat !== 'epub' || state.stage !== 2)
        return;
      if (state.operationId && state.status === 'converting')
        worker.postMessage({
          type: 'cancel',
          operationId: state.operationId,
        } satisfies WorkerRequest);
      state.operationId = operationId('epub-edit-pending');
      state.status = 'converting';
      delete state.output;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = setTimeout(() => {
        epubRefreshTimer = undefined;
        refreshEpubPreview();
      }, 300);
    },
    setStyleMapping(styleId: string, mapping: StyleMapping) {
      state.styleMappings = { ...state.styleMappings, [styleId]: mapping };
      state.outputSaved = false;
    },
    acceptHighConfidence() {
      state.styleMappings = acceptHighConfidenceMappings(
        state.model?.styles ?? [],
        state.styleMappings,
      );
      state.outputSaved = false;
    },
    rerunAnalysis() {
      if (!sourceInput || !sourceFilename) return;
      delete state.epubContentEdit;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      if (state.sourceFormat === 'pdf') {
        disposePdfPreview();
        state.pdfPreviewPage = 1;
        delete state.pdfPreviewRequested;
        delete state.pdfOriginalVisible;
      }
      autoPreviewOperationId = undefined;
      state.status = 'analysing';
      state.operationId = operationId('analyse');
      const input = sourceInput.slice(0);
      const sourceFormat =
        state.sourceFormat ??
        (sourceFilename.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx');
      worker.postMessage(
        {
          type: 'analyse',
          operationId: state.operationId,
          input,
          filename: sourceFilename,
          sourceFormat,
          conversionDate: state.conversionDate,
          styleMappings: state.styleMappings,
          ...(sourceFormat === 'pdf'
            ? { pdfOptions: pdfWorkerOptions(state) }
            : {}),
        } satisfies WorkerRequest,
        [input],
      );
    },
    rescanPdfSample() {
      if (!sourceInput || !sourceFilename || state.sourceFormat !== 'pdf')
        return;
      delete state.epubContentEdit;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      disposePdfPreview();
      state.pdfPreviewPage = 1;
      delete state.pdfPreviewRequested;
      delete state.pdfOriginalVisible;
      state.status = 'analysing';
      state.operationId = operationId('analyse-pdf-sample');
      autoPreviewOperationId = state.operationId;
      const input = sourceInput.slice(0);
      worker.postMessage(
        {
          type: 'analyse',
          operationId: state.operationId,
          input,
          filename: sourceFilename,
          sourceFormat: 'pdf',
          conversionDate: state.conversionDate,
          pdfOptions: pdfWorkerOptions(state, state.pdfImport.samplePageCount),
        } satisfies WorkerRequest,
        [input],
      );
    },
    setPdfCrop(edge, value) {
      const amount = Math.min(0.45, Math.max(0, value));
      if (edge === 'top') state.pdfImport.cropTop = amount;
      else state.pdfImport.cropBottom = amount;
      state.outputSaved = false;
    },
    setPdfPreviewPage(pageNumber) {
      requestPdfPage(pageNumber);
    },
    retryPdfPreview() {
      requestPdfPage(state.pdfPreviewPage);
    },
    setPdfPreviewScale(scale) {
      state.pdfPreviewScale = Math.min(4, Math.max(0.5, scale));
    },
    setPdfOriginalVisible(visible) {
      state.pdfOriginalVisible = visible;
      if (
        visible &&
        !state.pdfPreview &&
        !state.pdfPreviewLoading &&
        !state.pdfPreviewError
      )
        requestPdfPage(state.pdfPreviewPage);
    },
    setPdfSamplePageCount(pageCount) {
      const maximum = state.pdfAnalysis?.pageCount ?? 50;
      const minimum = Math.min(5, maximum);
      state.pdfImport.samplePageCount = Math.min(
        maximum,
        Math.max(minimum, Math.round(pageCount)),
      );
    },
    setPdfCandidateRemoval(candidateId, remove) {
      state.pdfImport.removedCandidateIds =
        state.pdfImport.removedCandidateIds.filter((id) => id !== candidateId);
      state.pdfImport.retainedCandidateIds =
        state.pdfImport.retainedCandidateIds.filter((id) => id !== candidateId);
      if (remove) state.pdfImport.removedCandidateIds.push(candidateId);
      else state.pdfImport.retainedCandidateIds.push(candidateId);
      const candidate = state.pdfAnalysis?.candidates.find(
        ({ id }) => id === candidateId,
      );
      if (candidate) candidate.removed = remove;
      state.outputSaved = false;
    },
    setFormulaDecision(decision) {
      state.pdfImport.formulaDecisions = {
        ...state.pdfImport.formulaDecisions,
        [decision.equationId]: decision,
      };
      state.outputSaved = false;
    },
    setFormulaReviewFilter(filter) {
      state.formulaReviewFilter = filter;
    },
    selectFormula(equationId) {
      state.formulaReviewSelectedId = equationId;
      const candidate = state.pdfAnalysis?.formulaCandidates?.find(
        ({ id }) => id === equationId,
      );
      if (candidate) requestPdfPage(candidate.page);
    },
    setFormulaDraft(equationId, tex) {
      state.formulaDrafts = { ...state.formulaDrafts, [equationId]: tex };
      const trimmed = tex.trim();
      const error = !trimmed
        ? 'LaTeX is required.'
        : isValidTex(trimmed)
          ? undefined
          : 'Enter valid LaTeX before saving.';
      const errors = { ...state.formulaValidationErrors };
      if (error) errors[equationId] = error;
      else delete errors[equationId];
      state.formulaValidationErrors = errors;
    },
    saveFormulaEdit(equationId) {
      const candidate = state.pdfAnalysis?.formulaCandidates?.find(
        ({ id }) => id === equationId,
      );
      const tex = (
        state.formulaDrafts[equationId] ??
        state.model?.equations[equationId]?.tex ??
        candidate?.tex ??
        candidate?.recognition?.tex ??
        ''
      ).trim();
      if (!tex || !isValidTex(tex)) {
        controller.setFormulaDraft?.(equationId, tex);
        return;
      }
      controller.setFormulaDecision?.({
        equationId,
        decision: 'formula',
        tex,
        ...(candidate
          ? { display: candidate.kind === 'display' ? 'block' : 'inline' }
          : {}),
      });
      controller.rerunAnalysis();
    },
    resetFormulaEdit(equationId) {
      const decisions = { ...state.pdfImport.formulaDecisions };
      const drafts = { ...state.formulaDrafts };
      const errors = { ...state.formulaValidationErrors };
      delete decisions[equationId];
      delete drafts[equationId];
      delete errors[equationId];
      state.pdfImport.formulaDecisions = decisions;
      state.formulaDrafts = drafts;
      state.formulaValidationErrors = errors;
      controller.rerunAnalysis();
    },
    rejectFormula(equationId) {
      controller.setFormulaDecision?.({ equationId, decision: 'text' });
      controller.rerunAnalysis();
    },
    acceptFormula(equationId) {
      const existing = state.pdfImport.formulaDecisions[equationId];
      controller.setFormulaDecision?.({
        equationId,
        decision: 'formula',
        ...(existing?.tex ? { tex: existing.tex } : {}),
        ...(existing?.display ? { display: existing.display } : {}),
        accepted: true,
      });
      controller.rerunAnalysis();
    },
    acceptHighConfidenceFormulas() {
      const equations = state.model?.equations ?? {};
      const decisions = { ...state.pdfImport.formulaDecisions };
      for (const candidate of state.pdfAnalysis?.formulaCandidates ?? []) {
        const confidence =
          candidate.recognition?.reviewConfidence ?? candidate.confidence;
        if (
          confidence !== 'high' ||
          !equations[candidate.id] ||
          decisions[candidate.id]?.decision === 'text'
        )
          continue;
        const existing = decisions[candidate.id];
        decisions[candidate.id] = {
          equationId: candidate.id,
          decision: 'formula',
          ...(existing?.tex ? { tex: existing.tex } : {}),
          ...(existing?.display ? { display: existing.display } : {}),
          accepted: true,
        };
      }
      state.pdfImport.formulaDecisions = decisions;
      state.outputSaved = false;
      controller.rerunAnalysis();
    },
    setPdfAutomaticFurnitureRemoval(remove) {
      state.pdfImport.removeDetectedFurniture = remove;
      state.outputSaved = false;
    },
    setPresetText(value: string) {
      state.presetText = value;
      delete state.editorNotice;
    },
    importPreset() {
      const result = importStylePreset(state.presetText);
      if (!result.ok || !result.mappings) {
        state.editorNotice = result.error ?? 'The preset is invalid.';
        return;
      }
      state.styleMappings = result.mappings;
      state.editorNotice = 'Preset imported. Rerun analysis to apply it.';
    },
    exportPreset() {
      state.presetText = exportStylePreset(state.styleMappings);
      state.editorNotice = 'Preset JSON is ready to copy or save.';
    },
    savePreset(name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;
      state.preferences.mappingPresets[trimmed] = { ...state.styleMappings };
      persistPreferences(localStorage, state.preferences);
      state.editorNotice = `Saved preset “${trimmed}”.`;
    },
    loadPreset(name: string) {
      const preset = state.preferences.mappingPresets[name];
      if (preset) state.styleMappings = { ...preset };
    },
    setMetadata(field: EditableMetadataField, value: string) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: setMetadataField(state.model.metadata, field, value),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    setSubjects(value: string) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: setSubjects(state.model.metadata, value.split(',')),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    setAuthors(value: string) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: setAuthors(state.model.metadata, parseAuthors(value)),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    addAuthor() {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: addAuthor(state.model.metadata),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    updateAuthor(index: number, person: Person) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: updateAuthor(state.model.metadata, index, person),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    removeAuthor(index: number) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: removeAuthor(state.model.metadata, index),
      };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    setCoverSource(source: CoverSource) {
      state.cover = { ...state.cover, source };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    updateCover(patch: Partial<CoverSettings>) {
      state.cover = { ...state.cover, ...patch };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    selectCoverFile(file: File) {
      const error = validateCoverFile(file);
      if (error) {
        state.cover = { ...state.cover, warning: error };
        return;
      }
      void file.arrayBuffer().then((data) => {
        try {
          const image = prepareCoverImage({
            mediaType: file.type as
              'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml',
            data: new Uint8Array(data),
          });
          const warning = titleTextWarning(
            file.name,
            state.model?.metadata.title?.value ?? '',
          );
          const next: CoverSettings = {
            ...state.cover,
            source: 'upload',
            image,
            imageName: file.name,
            ...(warning ? { warning } : {}),
          };
          if (!warning) delete next.warning;
          state.cover = next;
          state.outputSaved = false;
          refreshEpubPreview();
          m.redraw();
        } catch (cause) {
          state.cover = {
            ...state.cover,
            warning:
              cause instanceof Error
                ? cause.message
                : 'The cover image is invalid.',
          };
        }
      });
    },
    selectExtractedCover(assetId: string) {
      const asset = state.model?.assets[assetId];
      if (
        !asset ||
        !['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(
          asset.mediaType,
        )
      )
        return;
      const warning = titleTextWarning(
        assetId,
        state.model?.metadata.title?.value ?? '',
      );
      const next: CoverSettings = {
        ...state.cover,
        source: 'extracted',
        image: prepareCoverImage({
          mediaType: asset.mediaType as
            'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml',
          data: asset.data,
        }),
        imageName: assetId,
        ...(warning ? { warning } : {}),
      };
      if (!warning) delete next.warning;
      state.cover = next;
      state.outputSaved = false;
      refreshEpubPreview();
    },
  };
  return controller;
}

function epubMetadataIssues(state: AppState): boolean {
  const metadata = state.model?.metadata;
  const title = metadata?.title?.value.trim() ?? '';
  const language = metadata?.language?.value.trim() ?? '';
  const identifier = metadata?.identifier?.value.trim() ?? '';
  return Boolean(
    !title ||
    !identifier ||
    !language ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
  );
}

function applyResponse(state: AppState, response: WorkerResponse): void {
  if (response.operationId !== state.operationId) return;
  if (response.type === 'progress') state.progress = response.progress;
  if (response.type === 'analysed') {
    inferDocumentLanguage(response.model);
    state.model = response.model;
    if (response.pdfAnalysis) {
      state.pdfAnalysis = response.pdfAnalysis;
      if (
        response.pdfAnalysis.analysedPages.length ===
        response.pdfAnalysis.pageCount
      ) {
        const candidateIds = new Set(
          response.pdfAnalysis.formulaCandidates?.map(({ id }) => id) ?? [],
        );
        state.pdfImport.formulaDecisions = Object.fromEntries(
          Object.entries(state.pdfImport.formulaDecisions).filter(([id]) =>
            candidateIds.has(id),
          ),
        );
        state.formulaDrafts = Object.fromEntries(
          Object.entries(state.formulaDrafts).filter(([id]) =>
            candidateIds.has(id),
          ),
        );
        state.formulaValidationErrors = Object.fromEntries(
          Object.entries(state.formulaValidationErrors).filter(([id]) =>
            candidateIds.has(id),
          ),
        );
        if (
          state.formulaReviewSelectedId &&
          !candidateIds.has(state.formulaReviewSelectedId)
        )
          delete state.formulaReviewSelectedId;
      }
    } else delete state.pdfAnalysis;
    state.stage = 1;
    state.status = 'ready';
    delete state.progress;
  }

  if (response.type === 'output') {
    state.output = response;
    state.outputSaved = false;
    if (response.files?.[0]) state.selectedEpubFile = response.files[0];
    else delete state.selectedEpubFile;
    state.stage = 2;
    state.status = 'complete';
    delete state.progress;
  }
  if (response.type === 'error') {
    state.error = response.error;
    state.status = 'error';
    delete state.progress;
  }
}

function normalizeOutputFilename(value: string, fallback: string): string {
  const expectedExtension = /\.[^.]+$/.exec(fallback)?.[0] ?? '';
  const leaf = value.split(/[\\/]/).at(-1) ?? '';
  const cleaned = [...leaf]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  const basename =
    cleaned.replace(/\.(?:epub|html?|md|markdown|zip)$/i, '').trim() ||
    'document';
  return `${basename}${expectedExtension}`;
}

function pdfWorkerOptions(
  state: AppState,
  samplePageCount?: number,
): import('./worker/protocol.ts').PdfWorkerOptions {
  const removedCandidateIds = new Set(state.pdfImport.removedCandidateIds);
  for (const candidate of state.pdfAnalysis?.candidates ?? [])
    if (candidate.removed) removedCandidateIds.add(candidate.id);
  return {
    ...(samplePageCount !== undefined ? { samplePageCount } : {}),
    crop: {
      top: state.pdfImport.cropTop,
      bottom: state.pdfImport.cropBottom,
    },
    removeDetectedFurniture: state.pdfImport.removeDetectedFurniture,
    removedCandidateIds: [...removedCandidateIds],
    retainedCandidateIds: [...state.pdfImport.retainedCandidateIds],
    formulaDecisions: { ...state.pdfImport.formulaDecisions },
  };
}

function operationId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
