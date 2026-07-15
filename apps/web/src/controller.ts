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
      if (!state.model) return;
      state.status = 'converting';
      state.operationId = operationId('convert');
      worker.postMessage({
        type: 'convert',
        operationId: state.operationId,
        model: state.model,
        format: state.preferences.outputFormat,
        conversionDate: state.conversionDate,
      } satisfies WorkerRequest);
    },
    download() {
      if (!state.output) return;
      const url = URL.createObjectURL(
        new Blob([state.output.data], { type: state.output.mediaType }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = state.output.filename;
      anchor.click();
      URL.revokeObjectURL(url);
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
      state.stage = format === 'epub' ? 1 : 2;
      if (format !== 'epub') this.convert();
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
    },
    setSubjects(value: string) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: setSubjects(state.model.metadata, value.split(',')),
      };
    },
    addAuthor() {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: addAuthor(state.model.metadata),
      };
    },
    updateAuthor(index: number, person: Person) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: updateAuthor(state.model.metadata, index, person),
      };
    },
    removeAuthor(index: number) {
      if (!state.model) return;
      state.model = {
        ...state.model,
        metadata: removeAuthor(state.model.metadata, index),
      };
    },
  };
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
