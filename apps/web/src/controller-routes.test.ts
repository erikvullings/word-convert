// @vitest-environment jsdom

import m from 'mithril';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import { createBrowserController } from './controller.ts';

class WorkerStub {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  addEventListener(): void {}
}

function model(): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-09-04',
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

function createController() {
  vi.spyOn(m, 'redraw').mockImplementation(() => undefined);
  vi.stubGlobal('Worker', function WorkerConstructor() {
    return new WorkerStub();
  });
  vi.stubGlobal('caches', undefined);
  return createBrowserController();
}

describe('browser controller routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('navigates between output-format and format-specific routes', () => {
    const controller = createController();
    controller.state.model = model();

    controller.showOutputFormats?.();
    expect(window.location.pathname).toBe('/output-format');
    expect(controller.state.stage).toBe(1);

    controller.setOutputFormat('markdown');
    expect(window.location.pathname).toBe('/markdown');
    expect(controller.state).toMatchObject({
      stage: 2,
      preferences: { outputFormat: 'markdown' },
    });

    window.history.pushState({}, '', '/html');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(controller.state).toMatchObject({
      stage: 2,
      preferences: { outputFormat: 'html' },
    });

    window.history.pushState({}, '', '/output-format');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(controller.state.stage).toBe(1);
    controller.dispose?.();
  });

  it('normalizes a conversion route when no document is loaded', () => {
    window.history.replaceState({}, '', '/epub');

    const controller = createController();

    expect(controller.state.stage).toBe(0);
    expect(window.location.pathname).toBe('/');
    controller.dispose?.();
  });
});
