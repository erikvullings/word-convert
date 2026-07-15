import m from 'mithril';

import type { AppController } from './app.ts';
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
        const request: WorkerRequest = {
          type: 'analyse',
          operationId: state.operationId ?? operationId('analyse'),
          input,
          filename: file.name,
          conversionDate: state.conversionDate,
        };
        worker.postMessage(request, [input]);
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
    },
  };
}

function applyResponse(state: AppState, response: WorkerResponse): void {
  if (response.operationId !== state.operationId) return;
  if (response.type === 'progress') state.progress = response.progress;
  if (response.type === 'analysed') {
    state.model = response.model;
    state.stage = 2;
    state.status = 'ready';
    delete state.progress;
  }
  if (response.type === 'output') {
    state.output = response;
    state.stage = 7;
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
