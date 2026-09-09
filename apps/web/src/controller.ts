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
  rasterizeCover,
  titleTextWarning,
} from '@wordconvert/cover-generator';
import { BrowserPngCoverRasterizer } from './cover-rasterizer.ts';
import {
  canShareEpub,
  createEpubFile,
  openEpubEmail,
  saveDownload,
  shareEpub,
} from './download/index.ts';
import {
  contentEditorSource,
  contentImageDataUri,
  contentPartModel,
  contentPartSplitHeadings,
  contentPartSummaries,
  createPracticalContentPartState,
  deleteContentPart,
  importContentDataImages,
  insertContentImageMarkdown,
  mapDisplayedMarkdownSelection,
  mergeContentPart,
  nextContentImageId,
  normalizeContentPartState,
  saveContentPart,
  splitContentPart,
  unsupportedContentImageSources,
  withMarkdownContent,
} from './content-editor.ts';
import {
  fetchRemoteDocument,
  fetchRemoteHtmlImages,
  fetchRemoteHtmlStylesheets,
} from './remote-document.ts';
import {
  importRemoteTextDocumentWithSource,
  sanitizeEditedSourceHtml,
} from './text-document-import.ts';
import { inferDocumentLanguage } from './language.ts';
import { isValidTex } from '@wordconvert/math-converter';
import {
  adjustFormulaSelection,
  manualFormulaRegionId,
  normalizeFormulaSelection,
  type FormulaSelectionHandle,
  type FormulaSelectionPoint,
} from './formula-selection.ts';
import { normalizeFormulaTex } from './formula-review.ts';
import {
  clearCachedTexTellerAssets,
  hasCachedTexTellerAssets,
} from './texteller-cache.ts';
import { parseAppRoute, routePath, type AppRoute } from './routes.ts';

export function applyDocumentTheme(
  theme: ThemePreference,
  root: Pick<HTMLElement, 'dataset'>,
): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function createBrowserController(): AppController {
  const state: AppState = createInitialState(
    new Date().toLocaleDateString('en-CA'),
    loadPreferences(localStorage),
  );
  if (typeof document !== 'undefined')
    applyDocumentTheme(state.preferences.theme, document.documentElement);
  const colorSchemeQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined;
  const handleColorSchemeChange = (): void => {
    if (state.preferences.theme === 'system') m.redraw();
  };
  colorSchemeQuery?.addEventListener('change', handleColorSchemeChange);
  if (typeof caches === 'undefined') state.formulaCacheStatus = 'empty';
  else
    void hasCachedTexTellerAssets().then((cached) => {
      state.formulaCacheStatus = cached ? 'cached' : 'empty';
      m.redraw();
    });
  let worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
    type: 'module',
  });
  let sourceInput: ArrayBuffer | undefined;
  let sourceFilename: string | undefined;
  let autoPreviewOperationId: string | undefined;
  let pdfLayoutOperationId: string | undefined;
  let pdfCoverOperationId: string | undefined;
  let pdfCoverInitialized = false;
  let epubRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let remoteDocumentAbort: AbortController | undefined;
  let previewRenderer:
    import('./pdf-preview.ts').PdfPagePreviewRenderer | undefined;
  let pendingPdfPreviewPage: number | undefined;
  let pdfPreviewRendering = false;
  let pdfImageSelectionAnchor: FormulaSelectionPoint | undefined;
  let pdfImageInsertionOperation = 0;
  let pdfImageMarkdownSelection: { start: number; end: number } | undefined;
  let formulaSelectionAdjustment:
    | {
        bounds: import('@wordconvert/pdf-reader').PdfBounds;
        start: FormulaSelectionPoint;
        handle: FormulaSelectionHandle;
      }
    | undefined;
  let formulaSelectionSourceImageId: string | undefined;
  let disposed = false;
  const resetEpubPartState = (): void => {
    delete state.epubContentEdit;
    delete state.epubPartEditorMode;
    delete state.epubFullContentEdit;
    delete state.epubEditorNotice;
    delete state.epubParts;
    delete state.epubSplitBlockOffset;
    delete state.epubSplitHeadingIdentity;
    state.epubEditorRevision += 1;
    state.epubPreviewScope = 'book';
  };
  const ensureEpubParts = (): void => {
    if (!state.model) return;
    state.epubParts ??= createPracticalContentPartState(state.model);
    state.epubParts.activeIndex = Math.min(
      state.epubParts.starts.length - 1,
      Math.max(0, state.epubParts.activeIndex),
    );
  };
  const saveActiveEpubPart = (
    clearDraft = true,
    normalizeParts = clearDraft,
  ): boolean => {
    if (!state.model || state.epubContentEdit === undefined) return true;
    ensureEpubParts();
    if (!state.epubParts) return true;
    const importedImages = importContentDataImages(
      state.epubContentEdit,
      state.model,
    );
    if (!importedImages.ok) {
      state.epubEditorNotice = importedImages.message;
      state.status = 'ready';
      delete state.operationId;
      return false;
    }
    const unsupportedImages = unsupportedContentImageSources(
      importedImages.markdown,
      importedImages.model,
    );
    if (unsupportedImages.length > 0) {
      state.epubEditorNotice =
        'This part contains an image that is not stored in the book. Remove it before leaving the editor.';
      state.status = 'ready';
      delete state.operationId;
      return false;
    }
    const saved = saveContentPart(
      importedImages.model,
      state.epubParts,
      importedImages.markdown,
    );
    state.model = saved.model;
    state.epubParts = normalizeParts
      ? normalizeContentPartState(saved.model, saved.state)
      : saved.state;
    if (clearDraft) {
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
    }
    state.outputSaved = false;
    return true;
  };
  const saveFullEpubContent = (clearDraft = true): boolean => {
    if (!state.model || state.epubFullContentEdit === undefined) return true;
    const importedImages = importContentDataImages(
      state.epubFullContentEdit,
      state.model,
    );
    if (!importedImages.ok) {
      state.epubEditorNotice = importedImages.message;
      state.status = 'ready';
      delete state.operationId;
      return false;
    }
    const unsupportedImages = unsupportedContentImageSources(
      importedImages.markdown,
      importedImages.model,
    );
    if (unsupportedImages.length > 0) {
      state.epubEditorNotice =
        'The book contains an image that is not stored locally. Remove it before leaving the editor.';
      state.status = 'ready';
      delete state.operationId;
      return false;
    }
    state.model = withMarkdownContent(
      importedImages.model,
      importedImages.markdown,
    );
    state.epubParts = createPracticalContentPartState(state.model);
    if (clearDraft) {
      state.epubEditorRevision += 1;
      delete state.epubFullContentEdit;
    }
    state.outputSaved = false;
    return true;
  };
  const saveEpubDraftForMode = (
    mode = state.previewMode,
    clearDraft = true,
  ): boolean =>
    mode === 'edit'
      ? saveActiveEpubPart(clearDraft)
      : mode === 'source'
        ? saveFullEpubContent(clearDraft)
        : true;
  const savePendingEpubDraft = (clearDraft = true): boolean =>
    state.epubFullContentEdit !== undefined
      ? saveFullEpubContent(clearDraft)
      : saveActiveEpubPart(clearDraft);
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
    if (state.pdfImageSelectionOpen) {
      pdfImageInsertionOperation += 1;
      delete state.pdfImageInsertionLoading;
      delete state.pdfImageRegionSelectionActive;
      delete state.pdfImageSelectionBounds;
      state.pdfImageSelectionAlt = `Image from PDF page ${pageNumber}`;
      delete state.pdfImageInsertionError;
      pdfImageSelectionAnchor = undefined;
    }
    state.pdfPreviewRequested = true;
    state.pdfOriginalVisible = true;
    state.pdfPreviewLoading = true;
    delete state.pdfPreviewError;
    state.pdfPreviewOperationId = operationId('pdf-preview');
    pendingPdfPreviewPage = pageNumber;
    void renderPendingPdfPage();
  };
  const requestPdfFrontCover = (): void => {
    if (!sourceInput || state.sourceFormat !== 'pdf') {
      state.cover = {
        ...state.cover,
        warning: 'The original PDF page is not available.',
      };
      return;
    }
    const coverOperationId = operationId('pdf-cover');
    pdfCoverOperationId = coverOperationId;
    const input = sourceInput.slice(0);
    const loading: CoverSettings = {
      ...state.cover,
      source: 'pdf-page',
      warning: 'Rendering the original first page…',
    };
    delete loading.image;
    delete loading.imageName;
    state.cover = loading;
    void import('./pdf-preview.ts')
      .then(async ({ createPdfPagePreviewRenderer }) => {
        const renderer = createPdfPagePreviewRenderer();
        try {
          const preview = await renderer.render(input, 1);
          const image = prepareCoverImage({
            mediaType: 'image/png',
            data: new Uint8Array(await preview.blob.arrayBuffer()),
            width: preview.width,
            height: preview.height,
          });
          if (
            pdfCoverOperationId !== coverOperationId ||
            state.cover.source !== 'pdf-page'
          )
            return;
          const next: CoverSettings = {
            ...state.cover,
            source: 'pdf-page',
            image,
            imageName: 'Original PDF page 1',
          };
          delete next.warning;
          state.cover = next;
          state.outputSaved = false;
          refreshEpubPreview();
          m.redraw();
        } finally {
          await renderer.dispose();
        }
      })
      .catch((cause: unknown) => {
        if (
          pdfCoverOperationId !== coverOperationId ||
          state.cover.source !== 'pdf-page'
        )
          return;
        state.cover = {
          ...state.cover,
          warning:
            cause instanceof Error
              ? cause.message
              : 'The original PDF first page could not be rendered.',
        };
        m.redraw();
      });
  };
  const requestConvert = (): void => {
    if (!state.model) return;
    if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
    epubRefreshTimer = undefined;
    delete state.markdownEdit;
    if (
      state.preferences.outputFormat === 'epub' &&
      !savePendingEpubDraft(false)
    )
      return;
    state.outputSaved = false;
    state.status = 'converting';
    const conversionOperationId = operationId('convert');
    state.operationId = conversionOperationId;
    const metadata = state.model.metadata;
    const cover = coverComposition(state.cover, {
      title: metadata.title?.value ?? 'Untitled',
      ...(metadata.subtitle?.value
        ? { subtitle: metadata.subtitle.value }
        : {}),
      authors: metadata.authors.map(({ value }) => value.name),
    });
    const sourceHtml =
      state.sourceFormat === 'html' && state.sourceHtml
        ? state.epubSourceEdit === undefined
          ? state.sourceHtml
          : sanitizeEditedSourceHtml(
              state.epubSourceEdit,
              state.model.assets,
              state.sourceHtml.css,
            )
        : undefined;
    const request = {
      type: 'convert',
      operationId: conversionOperationId,
      model: state.model,
      filename: conversionSourceFilename(state, sourceFilename),
      format: state.preferences.outputFormat,
      conversionDate: state.conversionDate,
      formulaMode: state.preferences.formulaMode,
      includeInternalLinks: state.preferences.markdownIncludeInternalLinks,
      mode:
        state.preferences.outputFormat === 'html'
          ? state.preferences.htmlMode
          : state.preferences.outputFormat === 'markdown'
            ? state.preferences.markdownMode
            : 'epub',
      ...(state.preferences.outputFormat === 'epub' &&
      cover &&
      state.preferences.epubIncludeCover
        ? { cover }
        : {}),
      ...(sourceHtml ? { sourceHtml } : {}),
    } satisfies WorkerRequest;
    if (!request.cover) {
      worker.postMessage(request);
      return;
    }
    void rasterizeCover(request.cover, new BrowserPngCoverRasterizer())
      .then((coverPng) => {
        if (disposed || state.operationId !== conversionOperationId) return;
        const rasterizedRequest = {
          ...request,
          coverPng,
        } satisfies WorkerRequest;
        worker.postMessage(rasterizedRequest, [coverPng.buffer as ArrayBuffer]);
      })
      .catch(() => {
        if (disposed || state.operationId !== conversionOperationId) return;
        state.error = {
          code: 'conversion-failed',
          message: 'The EPUB cover could not be rendered as a PNG.',
          phase: 'write',
          recoverable: true,
        };
        state.status = 'error';
        delete state.operationId;
        delete state.progress;
        m.redraw();
      });
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

  const updateBrowserRoute = (
    route: AppRoute,
    mode: 'push' | 'replace' = 'push',
  ): void => {
    if (typeof history === 'undefined') return;
    const url = new URL(window.location.href);
    url.pathname = routePath(route, import.meta.env.BASE_URL);
    const routeState =
      route.page === 'conversion'
        ? { stage: 2, format: route.format }
        : { stage: route.page === 'output-format' ? 1 : 0 };
    history[mode === 'push' ? 'pushState' : 'replaceState'](
      routeState,
      '',
      url,
    );
  };

  const applyRoute = (route: AppRoute, convert: boolean): void => {
    if (
      state.preferences.outputFormat === 'epub' &&
      (route.page !== 'conversion' || route.format !== 'epub')
    )
      if (!savePendingEpubDraft()) return;
    delete state.review;
    if (route.page === 'document') {
      state.stage = 0;
      return;
    }
    if (!state.model) {
      state.stage = 0;
      updateBrowserRoute({ page: 'document' }, 'replace');
      return;
    }
    if (route.page === 'output-format') {
      state.stage = 1;
      delete state.output;
      delete state.markdownEdit;
      return;
    }
    const formatChanged = state.preferences.outputFormat !== route.format;
    state.preferences.outputFormat = route.format;
    persistPreferences(localStorage, state.preferences);
    state.stage = 2;
    if (formatChanged) {
      delete state.output;
      delete state.outputFilename;
      delete state.selectedEpubFile;
    }
    if (
      convert &&
      (formatChanged || !state.output) &&
      (route.format !== 'epub' || !epubMetadataIssues(state))
    )
      requestConvert();
  };

  const handlePopState = (event: PopStateEvent): void => {
    applyRoute(
      parseAppRoute(window.location.pathname, import.meta.env.BASE_URL),
      true,
    );
    state.review = ['styles', 'metadata', 'formula'].includes(
      event.state?.review,
    )
      ? event.state.review
      : undefined;
    m.redraw();
  };
  if (typeof window !== 'undefined') {
    const initialRoute = parseAppRoute(
      window.location.pathname,
      import.meta.env.BASE_URL,
    );
    if (initialRoute.page !== 'document')
      updateBrowserRoute({ page: 'document' }, 'replace');
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
      state.sourceFormat === 'pdf' &&
      !pdfCoverInitialized
    ) {
      pdfCoverInitialized = true;
      requestPdfFrontCover();
    }
    if (
      event.data.type === 'analysed' &&
      event.data.pdfAnalysis &&
      event.data.pdfAnalysis.analysedPages.length <
        event.data.pdfAnalysis.pageCount &&
      state.pdfImport.enhancedFigureDetection &&
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
      remoteDocumentAbort?.abort();
      remoteDocumentAbort = undefined;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      pdfCoverOperationId = undefined;
      pdfCoverInitialized = false;
      disposePdfPreview();
      worker.terminate();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', disposePdfPreview);
        window.removeEventListener('popstate', handlePopState);
      }
      colorSchemeQuery?.removeEventListener('change', handleColorSchemeChange);
    },
    reset() {
      if (
        state.outputSaved === false &&
        !confirm(
          'This document has changes that have not been downloaded. Discard everything and return home?',
        )
      )
        return;
      remoteDocumentAbort?.abort();
      remoteDocumentAbort = undefined;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      pdfCoverOperationId = undefined;
      pdfCoverInitialized = false;
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
      updateBrowserRoute({ page: 'document' }, 'replace');
      m.redraw();
    },
    selectFiles(files) {
      const file = files[0];
      if (!file) return;
      pdfCoverOperationId = undefined;
      pdfCoverInitialized = false;
      if (
        pdfLayoutOperationId ||
        state.status === 'analysing' ||
        state.status === 'converting'
      ) {
        replaceWorker();
        pdfLayoutOperationId = undefined;
      }
      remoteDocumentAbort?.abort();
      remoteDocumentAbort = undefined;
      delete state.remoteDocumentLoading;
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
      delete state.outputFilename;
      delete state.pdfImageSelectionOpen;
      delete state.pdfImageRegionSelectionActive;
      delete state.pdfImageSelectionBounds;
      delete state.pdfImageSelectionAlt;
      delete state.pdfImageInsertionLoading;
      delete state.pdfImageInsertionError;
      pdfImageSelectionAnchor = undefined;
      pdfImageMarkdownSelection = undefined;
      pdfImageInsertionOperation += 1;
      state.outputSaved = false;
      delete state.selectedEpubFile;
      resetEpubPartState();
      delete state.epubSourceEdit;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      delete state.model;
      delete state.sourceHtml;
      delete state.pdfAnalysis;
      state.pdfImport.formulaDecisions = {};
      state.pdfImport.manualFormulaRegions = [];
      state.formulaDrafts = {};
      state.formulaValidationErrors = {};
      delete state.formulaReviewSelectedId;
      delete state.formulaSelectionOpen;
      delete state.formulaSelectionAnchor;
      delete state.formulaSelectionBounds;
      state.formulaSelectionTex = '';
      formulaSelectionAdjustment = undefined;
      formulaSelectionSourceImageId = undefined;
      delete state.formulaExtractionId;
      delete state.formulaExtractionMessage;
      delete state.pdfLayoutStatus;
      state.pdfImport.enhancedFigureDetection = false;
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
      updateBrowserRoute({ page: 'output-format' });
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
      remoteDocumentAbort?.abort();
      remoteDocumentAbort = undefined;
      delete state.remoteDocumentLoading;
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
        updateBrowserRoute({ page: 'output-format' }, 'replace');
      } else {
        state.status = 'idle';
        state.stage = 0;
        delete state.selectedFilename;
        delete state.sourceFormat;
        delete state.outputSaved;
        updateBrowserRoute({ page: 'document' }, 'replace');
      }
      m.redraw();
    },
    setRemoteDocumentUrl(url) {
      state.remoteDocumentUrl = url;
      if (state.stage === 0) delete state.error;
    },
    loadRemoteDocument() {
      const url = state.remoteDocumentUrl.trim();
      if (!url || state.remoteDocumentLoading) return;
      remoteDocumentAbort?.abort();
      const abort = new AbortController();
      remoteDocumentAbort = abort;
      state.remoteDocumentLoading = true;
      delete state.error;
      void fetchRemoteDocument(url, fetch, abort.signal)
        .then(async (remoteDocument) => {
          if (remoteDocumentAbort !== abort) return;
          if (remoteDocument.format === 'pdf') {
            remoteDocumentAbort = undefined;
            delete state.remoteDocumentLoading;
            controller.selectFiles([remoteDocument.file]);
            m.redraw();
            return;
          }
          sourceInput = undefined;
          sourceFilename = remoteDocument.filename;
          state.selectedFilename = remoteDocument.filename;
          state.sourceFormat = remoteDocument.format;
          const [resources, stylesheets] =
            remoteDocument.format === 'html'
              ? await Promise.all([
                  fetchRemoteHtmlImages(
                    remoteDocument.content,
                    remoteDocument.sourceUrl,
                    fetch,
                    abort.signal,
                  ),
                  fetchRemoteHtmlStylesheets(
                    remoteDocument.content,
                    remoteDocument.sourceUrl,
                    fetch,
                    abort.signal,
                  ),
                ])
              : [[], []];
          if (remoteDocumentAbort !== abort) return;
          const imported = await importRemoteTextDocumentWithSource(
            remoteDocument.content,
            remoteDocument.format,
            {
              filename: remoteDocument.filename,
              sourceUrl: remoteDocument.sourceUrl,
              conversionDate: state.conversionDate,
              resources,
              stylesheets,
            },
          );
          if (remoteDocumentAbort !== abort) return;
          resetEpubPartState();
          state.model = imported.model;
          if (imported.sourceHtml) state.sourceHtml = imported.sourceHtml;
          else delete state.sourceHtml;
          inferDocumentLanguage(state.model);
          delete state.pdfAnalysis;
          delete state.progress;
          state.stage = 1;
          state.status = 'ready';
          updateBrowserRoute({ page: 'output-format' });
          remoteDocumentAbort = undefined;
          delete state.remoteDocumentLoading;
          m.redraw();
        })
        .catch((cause: unknown) => {
          if (remoteDocumentAbort !== abort) return;
          remoteDocumentAbort = undefined;
          delete state.remoteDocumentLoading;
          if (abort.signal.aborted) return;
          state.error = {
            code: 'invalid-input',
            message:
              cause instanceof Error
                ? cause.message
                : 'The remote document could not be loaded.',
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
    canShareDocument() {
      const output = state.output;
      if (output?.mediaType !== 'application/epub+zip') return false;
      return canShareEpub(
        createEpubFile(
          new Blob([output.data], { type: 'application/epub+zip' }),
          output.filename,
        ),
        {
          ...(typeof navigator.canShare === 'function'
            ? { canShare: (data) => navigator.canShare(data) }
            : {}),
          ...(typeof navigator.share === 'function'
            ? { share: (data) => navigator.share(data) }
            : {}),
        },
      );
    },
    shareDocument() {
      const output = state.output;
      if (output?.mediaType !== 'application/epub+zip') return;
      const title =
        state.model?.metadata.title?.value.trim() ||
        output.filename.replace(/\.epub$/i, '');
      void shareEpub(
        {
          blob: new Blob([output.data], { type: 'application/epub+zip' }),
          filename: output.filename,
          title,
          text: `EPUB: ${title}`,
        },
        {
          ...(typeof navigator.canShare === 'function'
            ? { canShare: (data) => navigator.canShare(data) }
            : {}),
          ...(typeof navigator.share === 'function'
            ? { share: (data) => navigator.share(data) }
            : {}),
        },
      ).then((result) => {
        if (result.status === 'failed') {
          state.error = {
            code: 'conversion-failed',
            message:
              'This EPUB could not be shared. You can download it instead.',
            recoverable: true,
          };
        }
        m.redraw();
      });
    },
    mailDocument() {
      const output = state.output;
      if (output?.mediaType !== 'application/epub+zip') return;
      const title =
        state.model?.metadata.title?.value.trim() ||
        output.filename.replace(/\.epub$/i, '');
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
        () => undefined,
      )
        .then((saved) => {
          if (!saved) return;
          state.outputSaved = true;
          openEpubEmail(
            { title, filename: output.filename },
            {
              openMailto: (url) => {
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.click();
              },
            },
          );
          m.redraw();
        })
        .catch(() => {
          state.error = {
            code: 'conversion-failed',
            message: 'The converted EPUB could not be saved for emailing.',
            recoverable: true,
          };
          m.redraw();
        });
    },
    setOutputFilename(filename) {
      const currentFilename = state.outputFilename ?? state.output?.filename;
      if (!currentFilename) return;
      state.outputFilename = normalizeOutputFilename(filename, currentFilename);
      if (state.output)
        state.output = { ...state.output, filename: state.outputFilename };
      state.outputSaved = false;
    },
    setMarkdownContent(content) {
      state.markdownEdit = content;
      state.outputSaved = false;
    },
    setTheme(theme: ThemePreference) {
      state.preferences.theme = theme;
      persistPreferences(localStorage, state.preferences);
      applyDocumentTheme(theme, document.documentElement);
    },
    setOutputFormat(format) {
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = undefined;
      if (state.preferences.outputFormat === 'epub' && !savePendingEpubDraft())
        return;
      state.preferences.outputFormat = format;
      persistPreferences(localStorage, state.preferences);
      delete state.output;
      delete state.outputFilename;
      delete state.selectedEpubFile;
      state.stage = 2;
      if (format === 'epub') ensureEpubParts();
      updateBrowserRoute({ page: 'conversion', format });
      if (format !== 'epub' || !epubMetadataIssues(state)) requestConvert();
    },
    showOutputFormats() {
      applyRoute({ page: 'output-format' }, false);
      updateBrowserRoute({ page: 'output-format' });
      m.redraw();
    },
    setFormulaMode(mode) {
      state.preferences.formulaMode = mode;
      persistPreferences(localStorage, state.preferences);
      delete state.output;
      if (state.stage === 2) requestConvert();
    },
    setFormulaRecognitionEnabled(enabled) {
      state.preferences.formulaRecognitionEnabled = enabled;
      persistPreferences(localStorage, state.preferences);
    },
    clearFormulaRecognitionCache() {
      if (typeof caches === 'undefined') return;
      state.formulaCacheStatus = 'clearing';
      void clearCachedTexTellerAssets().then(() => {
        state.formulaCacheStatus = 'empty';
        m.redraw();
      });
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
    setMarkdownIncludeInternalLinks(include) {
      state.preferences.markdownIncludeInternalLinks = include;
      persistPreferences(localStorage, state.preferences);
      delete state.output;
      if (state.stage === 2) requestConvert();
    },
    setEpubIncludeCover(include) {
      state.preferences.epubIncludeCover = include;
      persistPreferences(localStorage, state.preferences);
      refreshEpubPreview();
    },
    setEpubContent(content) {
      state.epubContentEdit = content;
      delete state.epubFullContentEdit;
      delete state.epubEditorNotice;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
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
    setEpubFullContent(content) {
      state.epubFullContentEdit = content;
      delete state.epubContentEdit;
      delete state.epubEditorNotice;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
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
    setEpubPreviewMode(mode) {
      if (!state.sourceHtml && !saveEpubDraftForMode()) return;
      state.previewMode = mode;
      if (mode !== 'edit') controller.cancelPdfImageSelection?.();
      if (mode !== 'edit' && mode !== 'source') refreshEpubPreview();
    },
    navigateEpubPart(direction) {
      if (!saveActiveEpubPart()) return;
      ensureEpubParts();
      if (!state.epubParts) return;
      const offset = direction === 'previous' ? -1 : 1;
      const activeIndex = state.epubParts.activeIndex + offset;
      if (activeIndex < 0 || activeIndex >= state.epubParts.starts.length)
        return;
      state.epubParts = { ...state.epubParts, activeIndex };
      state.previewMode = 'edit';
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
      delete state.epubEditorNotice;
    },
    setEpubPart(partIndex) {
      if (!saveActiveEpubPart()) return;
      ensureEpubParts();
      if (!state.epubParts || !Number.isInteger(partIndex)) return;
      const activeIndex = Math.min(
        Math.max(0, partIndex),
        state.epubParts.starts.length - 1,
      );
      state.epubParts = { ...state.epubParts, activeIndex };
      state.previewMode = 'edit';
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
      delete state.epubEditorNotice;
    },
    previewEpubContent(scope) {
      if (!saveActiveEpubPart()) return;
      state.epubPreviewScope = scope;
      state.previewMode = 'rendered';
      refreshEpubPreview();
    },
    mergeEpubPart(direction) {
      if (!saveActiveEpubPart(true, false)) return;
      ensureEpubParts();
      if (!state.model || !state.epubParts) return;
      const merged = mergeContentPart(state.model, state.epubParts, direction);
      if (!merged) {
        state.epubEditorNotice = `There is no ${direction} part to merge.`;
        return;
      }
      state.model = merged.model;
      state.epubParts = merged.state;
      state.epubEditorRevision += 1;
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
      state.epubEditorNotice =
        direction === 'previous'
          ? 'Merged with the previous part.'
          : 'Merged with the next part.';
      state.outputSaved = false;
      refreshEpubPreview();
    },
    deleteEpubPart() {
      if (!saveActiveEpubPart(true, false)) return;
      ensureEpubParts();
      if (!state.model || !state.epubParts) return;
      if (state.epubParts.starts.length <= 1) {
        state.epubEditorNotice = 'The only remaining part cannot be deleted.';
        return;
      }
      const parts = contentPartSummaries(state.model, state.epubParts);
      const title =
        parts[state.epubParts.activeIndex]?.title ??
        `Part ${state.epubParts.activeIndex + 1}`;
      if (!confirm(`Delete "${title}" and all of its content?`)) return;
      const deleted = deleteContentPart(state.model, state.epubParts);
      if (!deleted) return;
      state.model = deleted.model;
      state.epubParts = normalizeContentPartState(deleted.model, deleted.state);
      state.epubEditorRevision += 1;
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
      state.epubEditorNotice = `Deleted "${title}".`;
      state.outputSaved = false;
      refreshEpubPreview();
    },
    setEpubSplitHeading(blockOffset) {
      if (blockOffset === undefined) {
        delete state.epubSplitBlockOffset;
        delete state.epubSplitHeadingIdentity;
        return;
      }
      state.epubSplitBlockOffset = blockOffset;
      ensureEpubParts();
      if (!state.model || !state.epubParts) return;
      const currentPart = contentPartModel(state.model, state.epubParts);
      const draft =
        state.epubContentEdit === undefined
          ? currentPart
          : withMarkdownContent(currentPart, state.epubContentEdit);
      const headings = contentPartSplitHeadings(draft, {
        starts: [0],
        activeIndex: 0,
      });
      const selectedIndex = headings.findIndex(
        (heading) => heading.blockOffset === blockOffset,
      );
      const selected = headings[selectedIndex];
      if (!selected) {
        delete state.epubSplitHeadingIdentity;
        return;
      }
      state.epubSplitHeadingIdentity = {
        title: selected.title,
        occurrence: headings
          .slice(0, selectedIndex)
          .filter((heading) => heading.title === selected.title).length,
      };
    },
    splitEpubPart() {
      const blockOffset = state.epubSplitBlockOffset;
      const headingIdentity = state.epubSplitHeadingIdentity;
      if (!saveActiveEpubPart(true, false)) return;
      ensureEpubParts();
      if (!state.model || !state.epubParts || blockOffset === undefined) {
        state.epubEditorNotice =
          'Select a level-two heading to split this part.';
        return;
      }
      const currentPart = contentPartModel(state.model, state.epubParts);
      const matchingHeadings = headingIdentity
        ? contentPartSplitHeadings(currentPart, {
            starts: [0],
            activeIndex: 0,
          }).filter((heading) => heading.title === headingIdentity.title)
        : [];
      const resolvedBlockOffset =
        matchingHeadings[headingIdentity?.occurrence ?? -1]?.blockOffset ??
        blockOffset;
      const split = splitContentPart(
        state.model,
        state.epubParts,
        resolvedBlockOffset,
      );
      if (!split) {
        state.epubEditorNotice =
          'The selected heading is not a valid split point.';
        return;
      }
      state.model = split.model;
      state.epubParts = split.state;
      state.epubEditorRevision += 1;
      delete state.epubContentEdit;
      delete state.epubSplitBlockOffset;
      delete state.epubSplitHeadingIdentity;
      state.epubEditorNotice = 'Split the part at the selected heading.';
      state.outputSaved = false;
      refreshEpubPreview();
    },
    setEpubSourceContent(content) {
      state.epubSourceEdit = content;
      state.outputSaved = false;
      if (state.preferences.outputFormat !== 'epub' || state.stage !== 2)
        return;
      if (state.operationId && state.status === 'converting')
        worker.postMessage({
          type: 'cancel',
          operationId: state.operationId,
        } satisfies WorkerRequest);
      state.operationId = operationId('epub-source-edit-pending');
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
      resetEpubPartState();
      delete state.epubSourceEdit;
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
      if (sourceFormat !== 'docx' && sourceFormat !== 'pdf') return;
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
      resetEpubPartState();
      delete state.epubSourceEdit;
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
      if (!visible) {
        delete state.pdfImageSelectionOpen;
        delete state.pdfImageRegionSelectionActive;
        delete state.pdfImageSelectionBounds;
        delete state.pdfImageSelectionAlt;
        delete state.pdfImageInsertionLoading;
        delete state.pdfImageInsertionError;
        pdfImageSelectionAnchor = undefined;
        pdfImageMarkdownSelection = undefined;
        pdfImageInsertionOperation += 1;
      }
      if (
        visible &&
        !state.pdfPreview &&
        !state.pdfPreviewLoading &&
        !state.pdfPreviewError
      )
        requestPdfPage(state.pdfPreviewPage);
    },
    openPdfImageSelection(selection, displayedMarkdown) {
      pdfImageInsertionOperation += 1;
      state.pdfImageSelectionOpen = true;
      delete state.pdfImageRegionSelectionActive;
      delete state.pdfImageSelectionBounds;
      state.pdfImageSelectionAlt = `Image from PDF page ${state.pdfPreviewPage}`;
      delete state.pdfImageInsertionError;
      pdfImageSelectionAnchor = undefined;
      ensureEpubParts();
      const part =
        state.model && state.epubParts
          ? contentPartModel(state.model, state.epubParts)
          : undefined;
      const markdown =
        state.epubContentEdit ?? (part ? contentEditorSource(part) : '');
      const fallback = { start: markdown.length, end: markdown.length };
      pdfImageMarkdownSelection =
        selection && displayedMarkdown !== undefined
          ? mapDisplayedMarkdownSelection(
              displayedMarkdown,
              markdown,
              selection,
            )
          : (selection ?? fallback);
    },
    startPdfImageRegionSelection() {
      if (!state.pdfImageSelectionOpen || state.pdfImageInsertionLoading)
        return;
      state.pdfImageRegionSelectionActive = true;
      delete state.pdfImageSelectionBounds;
      delete state.pdfImageInsertionError;
      pdfImageSelectionAnchor = undefined;
    },
    insertPdfFullPageImage() {
      if (!state.pdfImageSelectionOpen || state.pdfImageInsertionLoading)
        return;
      delete state.pdfImageRegionSelectionActive;
      state.pdfImageSelectionBounds = { x: 0, top: 0, width: 1, height: 1 };
      controller.insertPdfImageSelection?.();
    },
    cancelPdfImageSelection() {
      pdfImageInsertionOperation += 1;
      delete state.pdfImageSelectionOpen;
      delete state.pdfImageRegionSelectionActive;
      delete state.pdfImageSelectionBounds;
      delete state.pdfImageSelectionAlt;
      delete state.pdfImageInsertionLoading;
      delete state.pdfImageInsertionError;
      pdfImageSelectionAnchor = undefined;
      pdfImageMarkdownSelection = undefined;
    },
    beginPdfImageSelection(point) {
      pdfImageSelectionAnchor = point;
      delete state.pdfImageSelectionBounds;
    },
    updatePdfImageSelection(point) {
      if (!pdfImageSelectionAnchor) return;
      const bounds = normalizeFormulaSelection(pdfImageSelectionAnchor, point);
      if (bounds) state.pdfImageSelectionBounds = bounds;
      else delete state.pdfImageSelectionBounds;
    },
    endPdfImageSelection(point) {
      controller.updatePdfImageSelection?.(point);
      pdfImageSelectionAnchor = undefined;
      if (state.pdfImageSelectionBounds) controller.insertPdfImageSelection?.();
    },
    setPdfImageSelectionBounds(bounds) {
      state.pdfImageSelectionBounds = { ...bounds };
    },
    setPdfImageSelectionAlt(alt) {
      state.pdfImageSelectionAlt = alt;
    },
    insertPdfImageSelection() {
      const input = sourceInput;
      const bounds = state.pdfImageSelectionBounds;
      const page = state.pdfPreview?.pageNumber ?? state.pdfPreviewPage;
      const alt =
        state.pdfImageSelectionAlt?.trim() || `Image from PDF page ${page}`;
      const selection = pdfImageMarkdownSelection;
      if (
        !input ||
        !bounds ||
        !selection ||
        !state.model ||
        state.pdfImageInsertionLoading
      )
        return;
      ensureEpubParts();
      const targetPartIndex = state.epubParts?.activeIndex;
      if (targetPartIndex === undefined) return;
      const operation = ++pdfImageInsertionOperation;
      state.pdfImageInsertionLoading = true;
      delete state.pdfImageInsertionError;
      void import('./pdf-preview.ts')
        .then(async ({ createPdfPagePreviewRenderer }) => {
          const renderer = createPdfPagePreviewRenderer();
          try {
            return await renderer.render(input, page, bounds);
          } finally {
            await renderer.dispose();
          }
        })
        .then(async (preview) => {
          if (
            operation !== pdfImageInsertionOperation ||
            !state.pdfImageSelectionOpen
          )
            return;
          if (sourceInput !== input) return;
          if (state.epubParts?.activeIndex !== targetPartIndex)
            throw new Error(
              'The active part changed before insertion finished.',
            );
          if (preview.blob.size > 10 * 1024 * 1024)
            throw new Error('The selected image exceeds the 10 MiB limit.');
          const model = state.model;
          const parts = state.epubParts;
          if (!model || !parts) return;
          const targetId = nextContentImageId(model);
          const part = contentPartModel(model, parts);
          const markdown = state.epubContentEdit ?? contentEditorSource(part);
          const imageData = new Uint8Array(await preview.blob.arrayBuffer());
          state.epubContentEdit = insertContentImageMarkdown(
            markdown,
            selection,
            contentImageDataUri('image/png', imageData),
            alt,
          );
          if (!saveActiveEpubPart(false, false)) return;
          if (state.model)
            state.model = {
              ...state.model,
              blocks: state.model.blocks.map((block) => {
                const inlineImage =
                  block.type === 'paragraph' &&
                  block.children.length === 1 &&
                  block.children[0]?.type === 'image' &&
                  block.children[0].assetId === targetId
                    ? block.children[0]
                    : undefined;
                if (block.type !== 'imageBlock' && inlineImage === undefined)
                  return block;
                if (block.type === 'imageBlock' && block.assetId !== targetId)
                  return block;
                return {
                  type: 'imageBlock',
                  assetId: targetId,
                  alt: inlineImage?.alt ?? alt,
                  width: Math.min(1, Math.max(0.2, bounds.width / 0.8)),
                  alignment: 'center',
                };
              }),
            };
          state.epubEditorRevision += 1;
          delete state.epubContentEdit;
          state.epubEditorNotice = `Inserted image from PDF page ${page}.`;
          state.outputSaved = false;
          controller.cancelPdfImageSelection?.();
          refreshEpubPreview();
        })
        .catch((cause: unknown) => {
          if (operation !== pdfImageInsertionOperation) return;
          state.pdfImageInsertionError =
            cause instanceof Error
              ? cause.message
              : 'The selected PDF image could not be inserted.';
        })
        .finally(() => {
          if (operation !== pdfImageInsertionOperation) return;
          state.pdfImageInsertionLoading = false;
          m.redraw();
        });
    },
    setPdfSamplePageCount(pageCount) {
      const maximum = state.pdfAnalysis?.pageCount ?? 50;
      const minimum = Math.min(5, maximum);
      state.pdfImport.samplePageCount = Math.min(
        maximum,
        Math.max(minimum, Math.round(pageCount)),
      );
    },
    setPdfEnhancedFigureDetection(enabled) {
      state.pdfImport.enhancedFigureDetection = enabled;
      state.outputSaved = false;
      if (!enabled) {
        if (pdfLayoutOperationId)
          worker.postMessage({
            type: 'cancel',
            operationId: pdfLayoutOperationId,
          } satisfies WorkerRequest);
        pdfLayoutOperationId = undefined;
        delete state.pdfLayoutStatus;
        return;
      }
      if (
        state.sourceFormat !== 'pdf' ||
        !state.pdfAnalysis ||
        state.pdfAnalysis.analysedPages.length >= state.pdfAnalysis.pageCount ||
        pdfLayoutOperationId ||
        state.pdfLayoutStatus === 'ready'
      )
        return;
      pdfLayoutOperationId = operationId('prepare-pdf-layout');
      state.pdfLayoutStatus = 'loading';
      worker.postMessage({
        type: 'prepare-pdf-layout',
        operationId: pdfLayoutOperationId,
      } satisfies WorkerRequest);
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
      const image = state.pdfAnalysis?.formulaImageRegions?.find(
        ({ id }) => id === equationId,
      );
      const page = candidate?.page ?? image?.page;
      if (page) requestPdfPage(page);
    },
    setFormulaDraft(equationId, tex) {
      const candidate = state.pdfAnalysis?.formulaCandidates?.find(
        ({ id }) => id === equationId,
      );
      state.formulaDrafts = { ...state.formulaDrafts, [equationId]: tex };
      const normalized = normalizeFormulaTex(tex);
      const error = !normalized
        ? 'LaTeX is required.'
        : isValidTex(normalized, candidate?.kind === 'display')
          ? undefined
          : 'Enter valid LaTeX before saving.';
      const errors = { ...state.formulaValidationErrors };
      if (error) errors[equationId] = error;
      else delete errors[equationId];
      state.formulaValidationErrors = errors;
    },
    saveFormulaImage(imageId, enteredTex) {
      const image = state.pdfAnalysis?.formulaImageRegions?.find(
        ({ id }) => id === imageId,
      );
      if (!image) return;
      const tex = normalizeFormulaTex(enteredTex);
      if (!tex || !isValidTex(tex, true)) {
        controller.setFormulaDraft?.(imageId, enteredTex);
        return;
      }
      state.pdfImport.manualFormulaRegions = [
        ...state.pdfImport.manualFormulaRegions.filter(
          ({ id }) => id !== imageId,
        ),
        {
          id: image.id,
          page: image.page,
          bounds: { ...image.bounds },
          kind: 'display',
          skipRecognition: true,
          sourceImageId: image.id,
        },
      ];
      state.formulaDrafts = { ...state.formulaDrafts, [imageId]: tex };
      controller.setFormulaDecision?.({
        equationId: imageId,
        decision: 'formula',
        tex,
        display: 'block',
      });
      state.formulaReviewSelectedId = imageId;
      delete state.formulaExtractionId;
      state.formulaExtractionMessage =
        'Formula saved from manual LaTeX. Review the result below.';
      controller.rerunAnalysis();
    },
    saveFormulaEdit(equationId) {
      const candidate = state.pdfAnalysis?.formulaCandidates?.find(
        ({ id }) => id === equationId,
      );
      const tex = normalizeFormulaTex(
        state.formulaDrafts[equationId] ??
          state.model?.equations[equationId]?.tex ??
          candidate?.tex ??
          candidate?.recognition?.tex ??
          '',
      );
      if (!tex || !isValidTex(tex, candidate?.kind === 'display')) {
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
    processFormulaImage(imageId) {
      const image = state.pdfAnalysis?.formulaImageRegions?.find(
        ({ id }) => id === imageId,
      );
      if (!image) return;
      state.pdfImport.manualFormulaRegions = [
        ...state.pdfImport.manualFormulaRegions.filter(
          ({ id }) => id !== imageId,
        ),
        {
          id: image.id,
          page: image.page,
          bounds: { ...image.bounds },
          kind: 'display',
          forceRecognition: true,
          sourceImageId: image.id,
        },
      ];
      controller.setFormulaDecision?.({
        equationId: image.id,
        decision: 'formula',
      });
      controller.setFormulaRecognitionEnabled?.(true);
      state.formulaReviewSelectedId = image.id;
      state.formulaExtractionId = image.id;
      state.formulaExtractionMessage = 'Extracting image with TexTeller...';
      controller.rerunAnalysis();
    },
    adjustFormulaImageRegion(imageId) {
      const image = state.pdfAnalysis?.formulaImageRegions?.find(
        ({ id }) => id === imageId,
      );
      if (!image) return;
      state.formulaSelectionOpen = true;
      state.formulaSelectionKind = 'display';
      state.formulaSelectionBounds = { ...image.bounds };
      delete state.formulaSelectionAnchor;
      formulaSelectionAdjustment = undefined;
      formulaSelectionSourceImageId = image.id;
      state.formulaSelectionTex = state.formulaDrafts[image.id] ?? '';
      state.pdfPreviewPage = image.page;
      requestPdfPage(image.page);
    },
    keepFormulaImage(imageId) {
      const region = state.pdfImport.manualFormulaRegions.find(
        ({ id, sourceImageId }) => id === imageId || sourceImageId === imageId,
      );
      const detected = state.pdfAnalysis?.formulaImageRegions?.some(
        ({ id }) => id === imageId,
      );
      if (!region && !detected) return;
      state.pdfImport.manualFormulaRegions =
        state.pdfImport.manualFormulaRegions.filter(
          ({ id }) => id !== region?.id,
        );
      controller.setFormulaDecision?.({
        equationId: imageId,
        decision: 'image',
        accepted: true,
      });
      controller.rerunAnalysis();
    },
    openFormulaSelection() {
      state.formulaSelectionOpen = true;
      state.formulaSelectionKind = 'inline';
      delete state.formulaSelectionAnchor;
      delete state.formulaSelectionBounds;
      formulaSelectionAdjustment = undefined;
      formulaSelectionSourceImageId = undefined;
      state.formulaSelectionTex = '';
      requestPdfPage(state.pdfPreviewPage);
    },
    cancelFormulaSelection() {
      delete state.formulaSelectionOpen;
      delete state.formulaSelectionAnchor;
      delete state.formulaSelectionBounds;
      formulaSelectionAdjustment = undefined;
      formulaSelectionSourceImageId = undefined;
    },
    setFormulaSelectionKind(kind) {
      state.formulaSelectionKind = kind;
    },
    beginFormulaSelection(point) {
      formulaSelectionAdjustment = undefined;
      state.formulaSelectionAnchor = point;
      delete state.formulaSelectionBounds;
    },
    beginFormulaSelectionAdjustment(handle, point) {
      const bounds = state.formulaSelectionBounds;
      if (!bounds) return;
      formulaSelectionAdjustment = {
        bounds: { ...bounds },
        start: point,
        handle,
      };
      delete state.formulaSelectionAnchor;
    },
    updateFormulaSelection(point) {
      if (formulaSelectionAdjustment) {
        state.formulaSelectionBounds = adjustFormulaSelection(
          formulaSelectionAdjustment.bounds,
          formulaSelectionAdjustment.start,
          point,
          formulaSelectionAdjustment.handle,
        );
        return;
      }
      if (!state.formulaSelectionAnchor) return;
      const bounds = normalizeFormulaSelection(
        state.formulaSelectionAnchor,
        point,
      );
      if (bounds) state.formulaSelectionBounds = bounds;
      else delete state.formulaSelectionBounds;
    },
    endFormulaSelection(point) {
      controller.updateFormulaSelection?.(point);
      delete state.formulaSelectionAnchor;
      formulaSelectionAdjustment = undefined;
    },
    setFormulaSelectionBounds(bounds) {
      state.formulaSelectionBounds = { ...bounds };
    },
    setFormulaSelectionTex(tex) {
      state.formulaSelectionTex = tex;
    },
    addManualFormulaRegion(enteredTex) {
      const bounds = state.formulaSelectionBounds;
      const page = state.pdfPreview?.pageNumber ?? state.pdfPreviewPage;
      if (!bounds) return;
      const tex = enteredTex ? normalizeFormulaTex(enteredTex) : undefined;
      if (
        enteredTex &&
        (!tex || !isValidTex(tex, state.formulaSelectionKind === 'display'))
      )
        return;
      const sourceImageId = formulaSelectionSourceImageId;
      const id = sourceImageId ?? manualFormulaRegionId(page, bounds);
      state.pdfImport.manualFormulaRegions = [
        ...state.pdfImport.manualFormulaRegions.filter(
          (region) => region.id !== id,
        ),
        {
          id,
          page,
          bounds: { ...bounds },
          kind: state.formulaSelectionKind,
          ...(tex ? { skipRecognition: true } : { forceRecognition: true }),
          ...(sourceImageId ? { sourceImageId } : {}),
        },
      ];
      controller.setFormulaDecision?.({
        equationId: id,
        decision: 'formula',
        ...(tex
          ? {
              tex,
              display:
                state.formulaSelectionKind === 'display' ? 'block' : 'inline',
            }
          : {}),
      });
      state.formulaReviewSelectedId = id;
      if (!tex) {
        state.formulaExtractionId = id;
        state.formulaExtractionMessage = sourceImageId
          ? 'Extracting the adjusted region with TexTeller...'
          : 'Extracting the selected region with TexTeller...';
        controller.setFormulaRecognitionEnabled?.(true);
      } else {
        state.formulaDrafts = { ...state.formulaDrafts, [id]: tex };
        delete state.formulaExtractionId;
        state.formulaExtractionMessage =
          'Formula saved from manual LaTeX. Review the result below.';
      }
      controller.cancelFormulaSelection?.();
      controller.rerunAnalysis();
    },
    removeManualFormulaRegion(equationId) {
      state.pdfImport.manualFormulaRegions =
        state.pdfImport.manualFormulaRegions.filter(
          ({ id }) => id !== equationId,
        );
      const decisions = { ...state.pdfImport.formulaDecisions };
      const drafts = { ...state.formulaDrafts };
      const errors = { ...state.formulaValidationErrors };
      delete decisions[equationId];
      delete drafts[equationId];
      delete errors[equationId];
      state.pdfImport.formulaDecisions = decisions;
      state.formulaDrafts = drafts;
      state.formulaValidationErrors = errors;
      if (state.formulaReviewSelectedId === equationId)
        delete state.formulaReviewSelectedId;
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
      pdfCoverOperationId = undefined;
      if (source === 'pdf-page') {
        requestPdfFrontCover();
        return;
      }
      state.cover = { ...state.cover, source };
      state.outputSaved = false;
      refreshEpubPreview();
    },
    updateCover(patch: Partial<CoverSettings>) {
      state.cover = { ...state.cover, ...patch };
      state.outputSaved = false;
      if (state.preferences.outputFormat !== 'epub' || state.stage !== 2)
        return;
      if (epubRefreshTimer !== undefined) clearTimeout(epubRefreshTimer);
      epubRefreshTimer = setTimeout(() => {
        epubRefreshTimer = undefined;
        refreshEpubPreview();
      }, 300);
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
    const extractionId = state.formulaExtractionId;
    if (extractionId && response.pdfAnalysis) {
      const extracted = response.pdfAnalysis.formulaCandidates?.find(
        ({ id, sourceImageId }) =>
          id === extractionId || sourceImageId === extractionId,
      );
      state.formulaExtractionMessage = extracted?.recognition
        ? 'Formula extracted. Review the result below.'
        : extracted?.recognitionFailure
          ? `TexTeller could not extract this region (${extracted.recognitionFailure}). Adjust the region or keep the image.`
          : 'TexTeller did not return a formula. Adjust the region or keep the image.';
      delete state.formulaExtractionId;
    }
    inferDocumentLanguage(response.model);
    delete state.epubContentEdit;
    delete state.epubFullContentEdit;
    delete state.epubEditorNotice;
    delete state.epubParts;
    delete state.epubSplitBlockOffset;
    delete state.epubSplitHeadingIdentity;
    state.epubEditorRevision += 1;
    state.epubPreviewScope = 'book';
    state.model = response.model;
    if (response.pdfAnalysis) {
      state.pdfAnalysis = response.pdfAnalysis;
      if (
        response.pdfAnalysis.analysedPages.length ===
        response.pdfAnalysis.pageCount
      ) {
        const candidateIds = new Set(
          [
            ...(response.pdfAnalysis.formulaCandidates ?? []),
            ...(response.pdfAnalysis.formulaImageRegions ?? []),
          ].map(({ id }) => id),
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
    state.outputFilename = state.outputFilename
      ? normalizeOutputFilename(state.outputFilename, response.filename)
      : response.filename;
    state.output = { ...response, filename: state.outputFilename };
    state.outputSaved = false;
    if (response.files?.[0]) state.selectedEpubFile = response.files[0];
    else delete state.selectedEpubFile;
    state.stage = 2;
    state.status = 'complete';
    delete state.progress;
  }
  if (response.type === 'error') {
    if (state.formulaExtractionId) {
      state.formulaExtractionMessage =
        'TexTeller extraction failed. Adjust the region or keep the image.';
      delete state.formulaExtractionId;
    }
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

function conversionSourceFilename(
  state: AppState,
  sourceFilename: string | undefined,
): string {
  const fallback = sourceFilename ?? state.selectedFilename ?? 'document.docx';
  if (state.preferences.outputFormat !== 'epub') return fallback;
  const identifier = state.model?.metadata.identifier?.value;
  const title = state.model?.metadata.title?.value.trim();
  if (!title || !isArxivUrl(identifier)) return fallback;
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, '-');
  return normalizeOutputFilename(safeTitle, 'document.epub');
}

function isArxivUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'arxiv.org' || hostname === 'www.arxiv.org';
  } catch {
    return false;
  }
}

function pdfWorkerOptions(
  state: AppState,
  samplePageCount?: number,
): import('./worker/protocol.ts').PdfWorkerOptions {
  const removedCandidateIds = new Set(state.pdfImport.removedCandidateIds);
  for (const candidate of state.pdfAnalysis?.candidates ?? [])
    if (candidate.removed) removedCandidateIds.add(candidate.id);
  return {
    formulaRecognitionEnabled: state.preferences.formulaRecognitionEnabled,
    layoutDetectionEnabled: state.pdfImport.enhancedFigureDetection,
    ...(samplePageCount !== undefined ? { samplePageCount } : {}),
    crop: {
      top: state.pdfImport.cropTop,
      bottom: state.pdfImport.cropBottom,
    },
    removeDetectedFurniture: state.pdfImport.removeDetectedFurniture,
    removedCandidateIds: [...removedCandidateIds],
    retainedCandidateIds: [...state.pdfImport.retainedCandidateIds],
    formulaDecisions: { ...state.pdfImport.formulaDecisions },
    manualFormulaRegions: state.pdfImport.manualFormulaRegions.map(
      (region) => ({
        ...region,
        bounds: { ...region.bounds },
      }),
    ),
  };
}

function operationId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
