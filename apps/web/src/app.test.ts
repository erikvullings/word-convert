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

    state.stage = 2;
    const styles = JSON.stringify(renderApp(controller));
    expect(styles).toContain('Style mapping table');
    expect(styles).toContain('Accept high-confidence proposals');
    expect(styles).toContain('Rerun analysis with mappings');
    expect(styles).toContain('JSON presets');
    expect(styles).toContain('Heading 6');
    expect(styles).toContain('No explicit formatting');

    state.stage = 3;
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
});

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
