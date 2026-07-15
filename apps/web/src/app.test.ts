import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import { renderApp, type AppController } from './app.ts';
import { createInitialState, WORKFLOW_STAGES } from './state.ts';

describe('App', () => {
  it('renders the complete local workflow with accessible file selection', () => {
    const controller: AppController = {
      state: createInitialState('2026-07-15'),
      selectFiles: () => undefined,
      cancel: () => undefined,
      convert: () => undefined,
      download: () => undefined,
      setTheme: () => undefined,
      setOutputFormat: () => undefined,
      setStyleMapping: () => undefined,
      acceptHighConfidence: () => undefined,
      rerunAnalysis: () => undefined,
      setPresetText: () => undefined,
      importPreset: () => undefined,
      exportPreset: () => undefined,
      savePreset: () => undefined,
      loadPreset: () => undefined,
      setMetadata: () => undefined,
      setSubjects: () => undefined,
      addAuthor: () => undefined,
      updateAuthor: () => undefined,
      removeAuthor: () => undefined,
    };

    const rendered = JSON.stringify(renderApp(controller));

    expect(WORKFLOW_STAGES).toEqual([
      'Document',
      'Format',
      'Preview',
      'Download',
    ]);
    for (const stage of WORKFLOW_STAGES) expect(rendered).toContain(stage);
    expect(rendered).toContain('All processing stays on this device');
    expect(rendered).toContain('Choose a DOCX document');
    expect(rendered).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('renders complete accessible style and metadata editors', () => {
    const state = createInitialState('2026-07-15');
    state.model = editorModel();
    const controller: AppController = {
      state,
      selectFiles: () => undefined,
      cancel: () => undefined,
      convert: () => undefined,
      download: () => undefined,
      setTheme: () => undefined,
      setOutputFormat: () => undefined,
      setStyleMapping: () => undefined,
      acceptHighConfidence: () => undefined,
      rerunAnalysis: () => undefined,
      setPresetText: () => undefined,
      importPreset: () => undefined,
      exportPreset: () => undefined,
      savePreset: () => undefined,
      loadPreset: () => undefined,
      setMetadata: () => undefined,
      setSubjects: () => undefined,
      addAuthor: () => undefined,
      updateAuthor: () => undefined,
      removeAuthor: () => undefined,
    };

    state.stage = 1;
    state.review = 'styles';
    const styles = JSON.stringify(renderApp(controller));
    expect(styles).toContain('Style mapping table');
    expect(styles).toContain('Accept high-confidence proposals');
    expect(styles).toContain('Rerun analysis with mappings');
    expect(styles).toContain('JSON presets');
    expect(styles).toContain('Heading 6');
    expect(styles).toContain('No explicit formatting');
    expect(styles).toContain('style-review-list');
    expect(styles).toContain('style-review-card');
    expect(styles).toContain('Mapping for Plain');
    expect(styles).toContain('"options":[{"id":"title"');
    expect(styles).not.toContain('table-scroll');
    expect(styles).not.toContain('style-table');

    state.review = 'metadata';
    const metadata = JSON.stringify(renderApp(controller));
    for (const label of [
      'Title',
      'Subtitle',
      'Authors',
      'Language',
      'Publisher',
      'Description',
      'Subjects',
      'Version',
      'Source created date',
      'Source modified date',
      'Publication date',
      'Conversion date',
      'Identifier',
      'Rights',
      'Sort as',
      'Role',
    ])
      expect(metadata).toContain(label);
    expect(metadata).toContain('default · certain · conversion settings');
  });

  it('offers output formats before optional review and only shows EPUB configuration for EPUB', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 1;
    state.status = 'ready';
    state.model = editorModel();
    const controller = controllerFor(state);

    const formats = JSON.stringify(renderApp(controller));
    expect(formats).toContain('HTML');
    expect(formats).toContain('Markdown');
    expect(formats).toContain('EPUB 3');
    expect(formats).toContain('Review style mapping');
    expect(formats).not.toContain('Cover image');

    state.preferences.outputFormat = 'epub';
    const epub = JSON.stringify(renderApp(controller));
    expect(epub).toContain('Cover image');
    expect(epub).toContain('EPUB configuration');
  });
});

function controllerFor(
  state: ReturnType<typeof createInitialState>,
): AppController {
  return {
    state,
    selectFiles: () => undefined,
    cancel: () => undefined,
    convert: () => undefined,
    download: () => undefined,
    setTheme: () => undefined,
    setOutputFormat: () => undefined,
    setStyleMapping: () => undefined,
    acceptHighConfidence: () => undefined,
    rerunAnalysis: () => undefined,
    setPresetText: () => undefined,
    importPreset: () => undefined,
    exportPreset: () => undefined,
    savePreset: () => undefined,
    loadPreset: () => undefined,
    setMetadata: () => undefined,
    setSubjects: () => undefined,
    addAuthor: () => undefined,
    updateAuthor: () => undefined,
    removeAuthor: () => undefined,
  };
}

function editorModel(): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [
        {
          value: { name: 'Ada Example' },
          provenance: {
            source: 'core properties',
            method: 'extracted',
            confidence: 'certain',
          },
        },
      ],
      subjects: [],
      conversionDate: {
        value: '2026-07-15',
        provenance: {
          source: 'conversion settings',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks: [],
    assets: {},
    equations: {},
    notes: {},
    warnings: [],
    styles: [
      {
        id: 'Plain',
        kind: 'paragraph',
        formatting: {},
        usageCount: 1,
        examples: ['Sample'],
        proposedMapping: 'body',
        reasons: ['Fallback'],
        provenance: {
          source: 'style analysis',
          method: 'inferred',
          confidence: 'medium',
        },
      },
    ],
  };
}
