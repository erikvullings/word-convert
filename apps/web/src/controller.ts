import m from 'mithril';
import type { Person, StyleMapping } from '@wordconvert/document-model';

import type { AppController } from './app.ts';
import {
  acceptHighConfidenceMappings,
  addAuthor,
  exportStylePreset,
  importStylePreset,
  removeAuthor,
  setMetadataField,
  setSubjects,
  updateAuthor,
  type EditableMetadataField,
} from './editors.ts';
import {
  createInitialState,
  loadPreferences,
  persistPreferences,
  validateDocxFile,
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
import { deliverDownload } from './download/index.ts';

export function createBrowserController(): AppController {
  const state: AppState = createInitialState(
    new Date().toLocaleDateString('en-CA'),
    loadPreferences(localStorage),
  );
  const worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
    type: 'module',
  });
  let sourceInput: ArrayBuffer | undefined;
  let sourceFilename: string | undefined;
  const requestConvert = (): void => {
    if (!state.model) return;
    delete state.markdownEdit;
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
      model: state.model,
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

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', (event: PopStateEvent) => {
      const stage =
        typeof event.state?.stage === 'number' ? event.state.stage : 1;
      state.review =
        event.state?.review === 'styles' || event.state?.review === 'metadata'
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
    });
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    applyResponse(state, event.data);
    m.redraw();
  });

  return {
    state,
    selectFiles(files) {
      const file = files[0];
      if (!file) return;
      const validation = validateDocxFile(file);
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
      delete state.selectedEpubFile;
      delete state.model;
      state.selectedFilename = file.name;
      state.stage = 1;
      state.status = 'analysing';
      state.operationId = operationId('analyse');
      void file.arrayBuffer().then((input) => {
        sourceInput = input;
        sourceFilename = file.name;
        const request: WorkerRequest = {
          type: 'analyse',
          operationId: state.operationId ?? operationId('analyse'),
          input: input.slice(0),
          filename: file.name,
          conversionDate: state.conversionDate,
        };
        worker.postMessage(request, [request.input]);
      });
    },
    cancel() {
      if (!state.operationId) return;
      worker.postMessage({
        type: 'cancel',
        operationId: state.operationId,
      } satisfies WorkerRequest);
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
      deliverDownload(
        output,
        {
          createObjectURL: (blob) => URL.createObjectURL(blob),
          revokeObjectURL: (url) => URL.revokeObjectURL(url),
          createAnchor: () => document.createElement('a'),
        },
        () => {
          if (state.preferences.outputFormat !== 'epub') delete state.output;
          delete state.markdownEdit;
        },
      );
    },
    setTheme(theme: ThemePreference) {
      state.preferences.theme = theme;
      persistPreferences(localStorage, state.preferences);
      document.documentElement.dataset.theme = theme;
    },
    setOutputFormat(format) {
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
    setStyleMapping(styleId: string, mapping: StyleMapping) {
      state.styleMappings = { ...state.styleMappings, [styleId]: mapping };
    },
    acceptHighConfidence() {
      state.styleMappings = acceptHighConfidenceMappings(
        state.model?.styles ?? [],
        state.styleMappings,
      );
    },
    rerunAnalysis() {
      if (!sourceInput || !sourceFilename) return;
      state.status = 'analysing';
      state.operationId = operationId('analyse');
      const input = sourceInput.slice(0);
      worker.postMessage(
        {
          type: 'analyse',
          operationId: state.operationId,
          input,
          filename: sourceFilename,
          conversionDate: state.conversionDate,
          styleMappings: state.styleMappings,
        } satisfies WorkerRequest,
        [input],
      );
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
      refreshEpubPreview();
    },
    setSubjects(value: string) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: setSubjects(state.model.metadata, value.split(',')),
      };
      refreshEpubPreview();
    },
    addAuthor() {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: addAuthor(state.model.metadata),
      };
      refreshEpubPreview();
    },
    updateAuthor(index: number, person: Person) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: updateAuthor(state.model.metadata, index, person),
      };
      refreshEpubPreview();
    },
    removeAuthor(index: number) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: removeAuthor(state.model.metadata, index),
      };
      refreshEpubPreview();
    },
    setCoverSource(source: CoverSource) {
      state.cover = { ...state.cover, source };
      refreshEpubPreview();
    },
    updateCover(patch: Partial<CoverSettings>) {
      state.cover = { ...state.cover, ...patch };
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
      refreshEpubPreview();
    },
  };
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
    state.model = response.model;
    state.stage = 1;
    state.status = 'ready';
    delete state.progress;
  }
  if (response.type === 'output') {
    state.output = response;
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

function operationId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
