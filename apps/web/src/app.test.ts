import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';
import { strToU8, zipSync } from 'fflate';

import {
  extractHtmlBody,
  outputPreviewSource,
  renderApp,
  type AppController,
} from './app.ts';
import { createInitialState } from './state.ts';

describe('App', () => {
  it.each([
    ['html', 'document.html', '<h1>Packaged HTML</h1>'],
    ['markdown', 'document.md', '# Packaged Markdown'],
  ] as const)(
    'previews the primary document inside a %s ZIP',
    (format, path, source) => {
      const data = zipSync({ [path]: strToU8(source) });
      expect(
        outputPreviewSource(
          {
            filename: `report-${format}.zip`,
            mediaType: 'application/zip',
            data: data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ),
          },
          format,
        ),
      ).toBe(source);
    },
  );

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
      setCoverSource: () => undefined,
      updateCover: () => undefined,
      selectCoverFile: () => undefined,
      selectExtractedCover: () => undefined,
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

    expect(rendered).toContain('Annual report');
    expect(rendered).toContain('Rendered');
    expect(rendered).toContain('Markdown');
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
      setCoverSource: () => undefined,
      updateCover: () => undefined,
      selectCoverFile: () => undefined,
      selectExtractedCover: () => undefined,
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
    expect(styles).toContain('Mapping for Plain');

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
    expect(formats).not.toContain('Cover image');
    expect(formats.indexOf('Markdown')).toBeLessThan(formats.indexOf('HTML'));
    expect(formats.indexOf('HTML')).toBeLessThan(formats.indexOf('EPUB 3'));
    expect(formats).not.toContain('Formula output');
  });

  it('shows formula output choices only when the analysis found formulas', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 1;
    state.status = 'ready';
    state.model = editorModel();
    state.model.equations.formula = {
      id: 'formula',
      source: { format: 'tex', value: 'x' },
      tex: 'x',
      conversionComplete: true,
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('Formula output');
    expect(rendered).toContain('Accessible MathML');
  });

  it('keeps format-specific settings inside their output cards', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 1;
    state.status = 'ready';
    state.model = editorModel();

    const rendered = JSON.stringify(renderApp(controllerFor(state)));
    const markdown = rendered.slice(
      rendered.indexOf('format-card--markdown'),
      rendered.indexOf('format-card--html'),
    );
    const html = rendered.slice(
      rendered.indexOf('format-card--html'),
      rendered.indexOf('format-card--epub'),
    );
    const epub = rendered.slice(rendered.indexOf('format-card--epub'));

    expect(markdown).toContain('Markdown packaging');
    expect(markdown).toContain('Single file');
    expect(markdown).toContain('ZIP with images folder');
    expect(html).toContain('HTML packaging');
    expect(html).toContain('Standalone file');
    expect(html).toContain('ZIP with asset folders');
    expect(epub).not.toContain('Markdown packaging');
    expect(epub).not.toContain('HTML packaging');
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
    expect(epub).toContain('Front cover');
    expect(epub).toContain('language must be a BCP 47 tag');
    expect(epub).toContain('identifier is missing');
    expect(epub).not.toContain('Create EPUB preview');
  });

  it('renders all cover controls and a live deterministic preview', () => {
    const state = createInitialState('2026-07-16');
    state.stage = 2;
    state.preferences.outputFormat = 'epub';
    state.cover.source = 'generated';
    state.model = editorModel();
    const rendered = JSON.stringify(renderApp(controllerFor(state)));
    for (const label of [
      'Text alignment',
      'Title position',
      'Author position',
      'Title size',
      'Author size',
      'Text colour',
      'Contrast panel',
      'Panel opacity',
      'Image opacity',
      'Safe margin',
      'Image crop',
      'Preview aspect ratio',
      'Live cover preview',
    ])
      expect(rendered).toContain(label);
    expect(rendered).toContain('semantic XHTML title page is always included');
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
    expect(epub).toContain('EPUB/nav.xhtml');
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

  it('places a collapsed, actionable warning panel after the preview', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.preferences.outputFormat = 'markdown';
    state.previewMode = 'source';
    state.model = editorModel();
    state.model.warnings = [
      {
        code: 'active-content-disabled',
        severity: 'warning',
        message: 'Potentially active content was excluded for safety.',
      },
      {
        code: 'formula-conversion-failed',
        severity: 'warning',
        message: 'A formula could not be converted.',
      },
    ];
    state.output = {
      filename: 'report.md',
      mediaType: 'text/markdown',
      data: new TextEncoder().encode('# Report').buffer,
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered.indexOf('markdown-source')).toBeLessThan(
      rendered.indexOf('warning-panel'),
    );
    expect(rendered).toContain('Warnings (2)');
    expect(rendered).toContain('Review formula output');
    expect(rendered).not.toContain('Review setting');
  });

  it('condenses duplicate warnings while retaining distinct style mapping actions', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.preferences.outputFormat = 'markdown';
    state.previewMode = 'source';
    state.model = editorModel();
    state.model.styles = [
      styleFixture('Emphasis', 'Emphasis'),
      styleFixture('Strong emphasis', 'StrongEmphasis'),
    ];
    state.model.warnings = [
      ...Array.from({ length: 2 }, () => ({
        code: 'markdown-table-span',
        severity: 'warning' as const,
        message: 'Markdown tables cannot preserve merged cell spans.',
      })),
      ...Array.from({ length: 2 }, () => ({
        code: 'markdown-unsupported-style-mark',
        severity: 'info' as const,
        message: 'A custom character style has no Markdown representation.',
        details: { styleId: 'Emphasis' },
      })),
      {
        code: 'markdown-unsupported-style-mark',
        severity: 'info' as const,
        message: 'A custom character style has no Markdown representation.',
        details: { styleId: 'StrongEmphasis' },
      },
    ];
    state.output = {
      filename: 'report.md',
      mediaType: 'text/markdown',
      data: new TextEncoder().encode('# Report').buffer,
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('Warnings (3)');
    expect(rendered).toContain('Review Emphasis mapping');
    expect(rendered).toContain('Review Strong emphasis mapping');
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
    setCoverSource: () => undefined,
    updateCover: () => undefined,
    selectCoverFile: () => undefined,
    selectExtractedCover: () => undefined,
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

function styleFixture(
  name: string,
  id: string,
): DocumentModel['styles'][number] {
  return {
    id,
    name,
    kind: 'character',
    formatting: {},
    usageCount: 1,
    examples: [],
    proposedMapping: 'body',
    reasons: [],
    provenance: {
      source: 'test',
      method: 'inferred',
      confidence: 'medium',
    },
  };
}
