import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';
import { strToU8, zipSync } from 'fflate';

import { extractHtmlBody, renderApp, type AppController } from './app.ts';
import { createInitialState } from './state.ts';

describe('App', () => {
  it('isolates standalone HTML body content from document-level theme styles', () => {
    expect(
      extractHtmlBody(
        '<!doctype html><html><head><style>body{color:black}</style></head><body><h1>Report</h1><p>Body</p></body></html>',
      ),
    ).toBe('<h1>Report</h1><p>Body</p>');
  });

  it('renders a focused local workflow with accessible file selection', () => {
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

    expect(rendered).not.toContain('Conversion workflow');
    expect(rendered).not.toContain('Current document');
    expect(rendered).toContain('All processing stays on this device');
    expect(rendered).toContain('Choose a DOCX document');
    expect(rendered).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('shows the document title quietly and uses radio buttons for Markdown preview mode', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.selectedFilename = 'report.docx';
    state.preferences.outputFormat = 'markdown';
    state.previewMode = 'source';
    state.model = editorModel();
    state.model.metadata.title = {
      value: 'Annual report',
      provenance: {
        source: 'document content',
        method: 'inferred',
        confidence: 'high',
      },
    };
    state.output = {
      filename: 'report.md',
      mediaType: 'text/markdown',
      data: new TextEncoder().encode('# Annual report').buffer,
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('document-context');
    expect(rendered).toContain('Annual report');
    expect(rendered).toContain('Rendered');
    expect(rendered).toContain('Markdown');
    expect(rendered).toContain('checkedId');
    expect(rendered).not.toContain('preview-tabs');
    expect(rendered).not.toContain('Current document');
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

  it('offers output formats without preview configuration and lists Markdown first', () => {
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
    expect(formats.indexOf('Markdown')).toBeLessThan(formats.indexOf('HTML'));
    expect(formats.indexOf('HTML')).toBeLessThan(formats.indexOf('EPUB 3'));
  });

  it('shows EPUB configuration in preview stage and explains metadata issues', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'ready';
    state.preferences.outputFormat = 'epub';
    state.model = editorModel();
    state.model.metadata.title = {
      value: 'Fixture',
      provenance: {
        source: 'test',
        method: 'user',
        confidence: 'certain',
      },
    };
    state.model.metadata.language = {
      value: '2057',
      provenance: {
        source: 'docProps/core.xml',
        method: 'extracted',
        confidence: 'certain',
      },
    };
    delete state.model.metadata.identifier;
    const controller = controllerFor(state);

    const epub = JSON.stringify(renderApp(controller));
    expect(epub).toContain('EPUB configuration');
    expect(epub).toContain('Cover image');
    expect(epub).toContain('language must be a BCP 47 tag');
    expect(epub).toContain('identifier is missing');
    expect(epub).not.toContain('Create EPUB preview');
  });

  it('renders EPUB file list as a selector with a right-side content viewer', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.preferences.outputFormat = 'epub';
    state.selectedEpubFile = 'EPUB/styles.css';
    state.model = editorModel();
    state.model.metadata.title = {
      value: 'Fixture',
      provenance: {
        source: 'test',
        method: 'user',
        confidence: 'certain',
      },
    };
    state.model.metadata.language = {
      value: 'en-GB',
      provenance: {
        source: 'docProps/core.xml',
        method: 'extracted',
        confidence: 'certain',
      },
    };
    state.model.metadata.identifier = {
      value: 'urn:fixture',
      provenance: {
        source: 'test',
        method: 'user',
        confidence: 'certain',
      },
    };
    state.output = {
      filename: 'fixture.epub',
      mediaType: 'application/epub+zip',
      data: epubFixtureBuffer(),
      files: ['EPUB/nav.xhtml', 'EPUB/styles.css'],
    };

    const epub = JSON.stringify(renderApp(controllerFor(state)));
    expect(epub).toContain('epub-layout-grid');
    expect(epub).toContain('epub-file-button');
    expect(epub).toContain('EPUB/nav.xhtml');
    expect(epub).toContain('epub-file-viewer');
    expect(epub).toContain('body{font-family:serif;}');
  });

  it('renders preview actions both above and below preview content', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.preferences.outputFormat = 'markdown';
    state.previewMode = 'source';
    state.model = editorModel();
    state.output = {
      filename: 'report.md',
      mediaType: 'text/markdown',
      data: new TextEncoder().encode('# Report').buffer,
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));
    expect((rendered.match(/Choose another format/g) ?? []).length).toBe(2);
    expect((rendered.match(/Review metadata/g) ?? []).length).toBe(2);
    expect((rendered.match(/Download report.md/g) ?? []).length).toBe(2);
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

function epubFixtureBuffer(): ArrayBuffer {
  const zipped = zipSync({
    'EPUB/nav.xhtml': strToU8(
      '<!doctype html><html><body><h1>Navigation</h1></body></html>',
    ),
    'EPUB/styles.css': strToU8('body{font-family:serif;}'),
  });
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  );
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
