import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';
import { strToU8, zipSync } from 'fflate';

import {
  dateInputValue,
  epubRenderedPreview,
  extractHtmlBody,
  markdownSourcePreview,
  navigateToWarning,
  outputPreviewSource,
  renderApp,
  scaledPreviewScrollOffset,
  type AppController,
} from './app.ts';
import { createInitialState } from './state.ts';

describe('App', () => {
  it('formats ISO timestamps for HTML date inputs', () => {
    expect(dateInputValue('2025-01-08T15:35:53Z')).toBe('2025-01-08');
    expect(dateInputValue('not-a-date')).toBe('');
    expect(dateInputValue('2025-02-31')).toBe('');
  });

  it('abbreviates image data URIs in the Markdown source preview', () => {
    expect(
      markdownSourcePreview(
        'Before ![Diagram](data:image/png;base64,AAECAwQFBgcICQ==) [site](https://example.com) after',
      ),
    ).toBe(
      'Before ![Diagram](data:image/png;base64,…) [site](https://example.com) after',
    );
  });

  it('keeps the original PDF horizontally centred while scaling', () => {
    expect(scaledPreviewScrollOffset(0, 800, 800, 1_200)).toBe(200);
    expect(scaledPreviewScrollOffset(300, 800, 1_600, 2_400)).toBe(650);
  });

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

  it('allows the generated output filename to be edited before download', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 3;
    state.output = {
      filename: 'report.epub',
      mediaType: 'application/epub+zip',
      data: new ArrayBuffer(1),
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('Output filename');
    expect(rendered).toContain('"value":"report"');
    expect(rendered).not.toContain('"value":"report.epub"');
  });

  it('renders a focused local workflow with accessible file selection', () => {
    const controller: AppController = {
      state: createInitialState('2026-07-15'),
      reset: () => undefined,
      selectFiles: () => undefined,
      cancel: () => undefined,
      convert: () => undefined,
      download: () => undefined,
      setOutputFilename: () => undefined,
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
      setAuthors: () => undefined,
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
    expect(rendered).toContain('Go to WordConvert home');
    expect(rendered).toContain('All processing stays on this device');
    expect(rendered).toContain('Choose a DOCX or PDF document');
    expect(rendered).toContain('Open a document from a URL');
    expect(rendered).toContain('https://arxiv.org/abs/1706.03762');
    expect(rendered).toContain('arXiv links automatically use');
    expect(rendered).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(rendered).toContain('application/pdf');
  });

  it('shows PDF crop preview and reviewable page-furniture candidates', () => {
    const state = createInitialState('2026-08-29');
    state.stage = 1;
    state.status = 'ready';
    state.sourceFormat = 'pdf';
    state.pdfImport.cropTop = 0.08;
    state.pdfImport.cropBottom = 0.06;
    state.pdfAnalysis = {
      pageCount: 12,
      analysedPages: [1, 4, 8, 12],
      crop: { top: 0.08, bottom: 0.06 },
      scannedPages: [],
      candidates: [
        {
          id: 'header-1',
          kind: 'header',
          text: 'Chapter One',
          normalizedText: 'chapter one',
          pageParity: 'odd',
          pageNumbers: [1, 3, 5],
          confidence: 'high',
          removed: true,
        },
      ],
    };
    state.pdfPreviewPage = 3;
    state.pdfPreviewRequested = true;
    state.pdfPreview = {
      pageNumber: 3,
      width: 900,
      height: 1200,
      url: 'blob:pdf-page-3',
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('PDF page cleanup');
    expect(rendered).not.toContain('Reload source-page preview');
    expect(rendered).not.toContain('Load source-page preview');
    expect(rendered).not.toContain('Source-page preview (optional)');
    expect(rendered).toContain('PDF page 3 preview');
    expect(rendered).toContain('Page 3 of 12');
    expect(rendered).not.toContain('Showing 3 to 3 of 12 pages');
    expect(rendered).toContain('Pages to sample');
    expect(rendered).toContain('"label":"Pages to sample"');
    expect(rendered).toContain('Currently scanned: 1, 4, 8, 12');
    expect(rendered).toContain('Top crop: 8%');
    expect(rendered).toContain('Bottom crop: 6%');
    expect(rendered).toContain('Original scale: 100%');
    expect(rendered).toContain('"max":400');
    expect(rendered).toContain('pdf-preview-workspace--compact');
    expect(rendered.indexOf('pdf-page-preview')).toBeLessThan(
      rendered.indexOf('pdf-crop-sliders'),
    );
    expect(rendered.indexOf('pdf-crop-sliders')).toBeLessThan(
      rendered.indexOf('Page 3 of 12'),
    );
    expect(rendered).toContain(
      'Remove from output · header · odd pages · high confidence',
    );
    expect(rendered).toContain('Process all 12 pages and apply cleanup');
  });

  it('retains the last PDF preview while loading and offers retry on failure', () => {
    const state = createInitialState('2026-08-31');
    state.stage = 1;
    state.status = 'ready';
    state.sourceFormat = 'pdf';
    state.pdfAnalysis = {
      pageCount: 12,
      analysedPages: [1, 4, 8, 12],
      crop: { top: 0, bottom: 0 },
      scannedPages: [],
      candidates: [],
    };
    state.pdfPreviewPage = 4;
    state.pdfPreviewRequested = true;
    state.pdfPreviewLoading = true;
    state.pdfPreview = {
      pageNumber: 3,
      width: 900,
      height: 1200,
      url: 'blob:pdf-page-3',
    };

    const loading = JSON.stringify(renderApp(controllerFor(state)));
    expect(loading).toContain('PDF page 3 preview');
    expect(loading).toContain('Rendering page preview…');

    state.pdfPreviewLoading = false;
    state.pdfPreviewError = 'Preview render failed.';
    const failed = JSON.stringify(renderApp(controllerFor(state)));
    expect(failed).toContain('PDF page 3 preview');
    expect(failed).toContain('Preview render failed.');
    expect(failed).toContain('Retry preview');
  });

  it('shows preview controls only when active and offers loading after full processing', () => {
    const state = createInitialState('2026-08-30');
    state.stage = 1;
    state.status = 'ready';
    state.sourceFormat = 'pdf';
    state.pdfAnalysis = {
      pageCount: 6,
      analysedPages: [1, 4, 6],
      crop: { top: 0, bottom: 0 },
      scannedPages: [],
      candidates: [],
    };

    const sample = JSON.stringify(renderApp(controllerFor(state)));
    expect(sample).not.toContain('pdf-crop-layout');
    expect(sample).not.toContain('Load source-page preview');

    state.pdfAnalysis.analysedPages = [1, 2, 3, 4, 5, 6];
    const processed = JSON.stringify(renderApp(controllerFor(state)));
    expect(processed).not.toContain('pdf-crop-layout');
    expect(processed).not.toContain('PDF page cleanup');
    expect(processed).not.toContain('Load source-page preview');
    expect(processed).not.toContain('Detected page furniture');
  });

  it('offers an optional original PDF beside converted output', () => {
    const state = createInitialState('2026-08-30');
    state.stage = 2;
    state.status = 'complete';
    state.sourceFormat = 'pdf';
    state.preferences.outputFormat = 'markdown';
    state.previewMode = 'source';
    state.model = editorModel();
    state.pdfAnalysis = {
      pageCount: 6,
      analysedPages: [1, 2, 3, 4, 5, 6],
      crop: { top: 0, bottom: 0 },
      scannedPages: [],
      candidates: [],
    };
    state.output = {
      filename: 'report.md',
      mediaType: 'text/markdown',
      data: new TextEncoder().encode('# Report').buffer,
    };

    const hidden = JSON.stringify(renderApp(controllerFor(state)));
    expect(hidden).toContain('Show original');
    expect(hidden).toContain('workspace--preview');
    expect(hidden).not.toContain('preview-comparison--visible');

    state.pdfOriginalVisible = true;
    state.pdfPreviewRequested = true;
    const visible = JSON.stringify(renderApp(controllerFor(state)));
    expect(visible).toContain('Hide original');
    expect(visible).toContain('preview-comparison--visible');
    expect(visible).toContain('Original PDF');
    expect(visible).toContain('Converted document');
    expect(visible).toContain('Original scale: 100%');
    expect(visible).toContain('--pdf-preview-scale');
    expect(visible.indexOf('markdown-preview-mode')).toBeLessThan(
      visible.indexOf('Hide original'),
    );
    expect(visible.indexOf('Hide original')).toBeLessThan(
      visible.indexOf('preview-comparison'),
    );
    expect(visible).not.toContain(
      'This is the source page with crop bands overlaid.',
    );
    expect(visible.indexOf('pdf-page-preview')).toBeLessThan(
      visible.indexOf('pdf-preview-scale'),
    );
    expect(visible.indexOf('pdf-preview-scale')).toBeLessThan(
      visible.indexOf('Page 1 of 6'),
    );
    expect(visible).not.toContain('Showing 1 to 1 of 6 pages');
  });

  it('shows active PDF analysis progress in the loading status', () => {
    const state = createInitialState('2026-08-30');
    state.stage = 1;
    state.status = 'analysing';
    state.sourceFormat = 'pdf';
    state.selectedFilename = 'report.pdf';
    state.progress = {
      phase: 'inspect',
      completed: 0,
      total: 0,
      message: 'Opening PDF…',
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('analysis-status');
    expect(rendered).toContain('Opening PDF…');
    expect(rendered.match(/progress-status/g)).toHaveLength(1);
    expect(rendered.indexOf('progress-status')).toBeLessThan(
      rendered.indexOf('secondary-actions'),
    );
  });

  it('shows background figure detection and places pagination under crop controls', () => {
    const state = createInitialState('2026-09-01');
    state.stage = 1;
    state.status = 'ready';
    state.sourceFormat = 'pdf';
    state.pdfLayoutStatus = 'loading';
    state.pdfPreviewRequested = true;
    state.pdfAnalysis = {
      pageCount: 44,
      analysedPages: [1, 12, 23, 33, 44],
      crop: { top: 0, bottom: 0 },
      candidates: [],
      scannedPages: [],
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('one-time model download on first use');
    expect(rendered).not.toContain('Crop bands remove text only');
    expect(rendered).not.toContain(
      'Automatically remove high-confidence repeated content',
    );
    expect(rendered).toContain('Page 1 of 44');
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
      reset: () => undefined,
      selectFiles: () => undefined,
      cancel: () => undefined,
      convert: () => undefined,
      download: () => undefined,
      setOutputFilename: () => undefined,
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
      setAuthors: () => undefined,
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

  it('shows Formula Review for fully analysed PDFs and exposes review controls', () => {
    const state = createInitialState('2026-09-02');
    state.stage = 1;
    state.status = 'ready';
    state.sourceFormat = 'pdf';
    state.model = editorModel();
    const withoutFormula = JSON.stringify(renderApp(controllerFor(state)));
    expect(withoutFormula).toContain('Review formulas');
    state.review = 'formula';
    const emptyReview = JSON.stringify(renderApp(controllerFor(state)));
    expect(emptyReview).toContain('Add missed formula');
    expect(emptyReview).toContain('No formulas match this filter.');
    delete state.review;

    state.model.equations = {
      'pdf-equation-p2-001': {
        id: 'pdf-equation-p2-001',
        source: { format: 'tex', value: 'x^2' },
        tex: 'x^2',
        conversionComplete: true,
        display: 'block',
        recognition: {
          method: 'pdf-onnx',
          confidence: 0.9,
          model: 'texteller-onnx-q4',
        },
        location: {
          kind: 'pdf',
          page: 2,
          x: 0.2,
          top: 0.3,
          width: 0.4,
          height: 0.08,
          spanIds: ['formula-span'],
        },
        review: { status: 'unreviewed' },
      },
    };
    state.pdfAnalysis = {
      pageCount: 2,
      analysedPages: [1, 2],
      crop: { top: 0, bottom: 0 },
      scannedPages: [],
      candidates: [],
      formulaCandidates: [
        {
          id: 'pdf-equation-p2-001',
          page: 2,
          kind: 'display',
          bounds: { x: 0.2, top: 0.3, width: 0.4, height: 0.08 },
          spanIds: ['formula-span'],
          features: {
            mathFontRatio: 1,
            operatorRatio: 0.2,
            greekRatio: 0,
            symbolRatio: 0.2,
            singleLetterTokenRatio: 0.5,
            dictionaryLikeWordRatio: 0,
            superscriptCount: 0,
            subscriptCount: 0,
            baselineVariance: 0,
            fontSizeVariance: 0,
            centered: true,
            isolated: true,
            equationNumberAtRight: false,
            multilineStructure: false,
            score: 5,
            confidence: 'high',
          },
          score: 5,
          confidence: 'high',
          sources: ['heron'],
          requiresRecognition: true,
          recognition: {
            tex: 'x^2',
            model: 'texteller-onnx-q4',
            reviewConfidence: 'high',
            diagnostics: { backend: 'wasm', tokens: 3 },
          },
        },
      ],
    };
    state.pdfPreview = {
      pageNumber: 2,
      width: 600,
      height: 800,
      url: 'blob:formula-source-page',
    };

    const chooser = JSON.stringify(renderApp(controllerFor(state)));
    expect(chooser).toContain('Review formulas');
    state.review = 'formula';
    const review = JSON.stringify(renderApp(controllerFor(state)));
    for (const text of [
      'Formula Review',
      'Needs review',
      'high confidence',
      'ONNX recognition',
      'Block formula',
      'Unreviewed',
      'LaTeX',
      'Original PDF region',
      'Original PDF formula region on page 2',
      'blob:formula-source-page',
      'Rendered formula',
      'Save edit',
      'Reset detected value',
      'Not a formula',
      'Accept result',
      'Previous formula',
      'Next formula',
      'Accept all high-confidence formulas',
      'Add missed formula',
      'Review Done, return',
    ])
      expect(review).toContain(text);
    expect(review).not.toContain('secondary-actions');
    expect(review.match(/blob:formula-source-page/g)).toHaveLength(1);

    state.pdfAnalysis.formulaImageRegions = [
      {
        id: 'pdf-equation-2-0',
        page: 2,
        bounds: { x: 0.1, top: 0.2, width: 0.3, height: 0.1 },
      },
    ];
    state.formulaReviewSelectedId = 'pdf-equation-2-0';
    const imageReview = JSON.stringify(renderApp(controllerFor(state)));
    expect(imageReview).toContain('Detected image');
    expect(imageReview).toContain('Original PDF image region on page 2');
    expect(imageReview).toContain('Extract images');
    expect(imageReview).toContain('Adjust region');
    expect(imageReview).toContain('Keep the image');
    expect(imageReview).toContain('maxWidth":"522px');
    expect(imageReview).not.toContain('Rendered formula');
    expect(imageReview).toContain('Enter LaTeX or reuse a previous formula');
    expect(imageReview).toContain('Use previous formula');
    expect(imageReview).toContain('Use typed formula');

    state.formulaSelectionOpen = true;
    state.formulaSelectionKind = 'display';
    state.formulaSelectionBounds = {
      x: 0.1,
      top: 0.2,
      width: 0.3,
      height: 0.1,
    };
    const selection = JSON.stringify(renderApp(controllerFor(state)));
    expect(selection).toContain('formula-selection-box');
    expect(selection).toContain('formula-selection-handle--se');
    expect(selection).not.toContain('Region percentages');
  });

  it('routes formula warnings to the referenced Formula Review item', () => {
    const state = createInitialState('2026-09-02');
    state.stage = 2;
    state.formulaReviewFilter = 'accepted';

    navigateToWarning(state, 'formula', undefined, 'pdf-equation-p4-002');

    expect(state).toMatchObject({
      review: 'formula',
      formulaReviewFilter: 'all',
      formulaReviewSelectedId: 'pdf-equation-p4-002',
    });
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
    state.previewMode = 'package';
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
    state.previewMode = 'package';
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
    state.previewMode = 'package';
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

  it('offers content editing and package inspection for EPUB previews', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.sourceFormat = 'pdf';
    state.preferences.outputFormat = 'epub';
    state.previewMode = 'edit';
    state.selectedEpubFile = 'EPUB/styles.css';
    state.model = editorModel();
    state.model.blocks = [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Editable EPUB content' }],
      },
    ];
    state.model.metadata.title = {
      value: 'Fixture',
      provenance: { source: 'test', method: 'user', confidence: 'certain' },
    };
    state.model.metadata.language = {
      value: 'en',
      provenance: { source: 'test', method: 'user', confidence: 'certain' },
    };
    state.model.metadata.identifier = {
      value: 'urn:fixture',
      provenance: { source: 'test', method: 'user', confidence: 'certain' },
    };
    state.output = {
      filename: 'fixture.epub',
      mediaType: 'application/epub+zip',
      data: epubFixtureBuffer(),
      files: ['EPUB/styles.css'],
    };

    const rendered = JSON.stringify(renderApp(controllerFor(state)));

    expect(rendered).toContain('epub-preview-mode');
    expect(rendered).toContain('Rendered');
    expect(rendered).toContain('Markdown');
    expect(rendered).toContain('Edit');
    expect(rendered).toContain('EPUB files');
    expect(rendered).toContain('Editable EPUB content');
    expect(rendered).toContain('Show original');
  });

  it('preserves inline equation image presentation in the EPUB preview', () => {
    const state = createInitialState('2026-07-15');
    state.stage = 2;
    state.status = 'complete';
    state.preferences.outputFormat = 'epub';
    state.previewMode = 'rendered';
    state.model = editorModel();
    state.model.blocks = [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Before' },
          {
            type: 'image',
            assetId: 'equation-image',
            presentation: 'equation',
            width: 0.47,
          },
          { type: 'text', text: 'After' },
        ],
      },
    ];
    state.model.assets['equation-image'] = {
      id: 'equation-image',
      mediaType: 'image/png',
      data: Uint8Array.from([137, 80, 78, 71]),
    };
    state.output = {
      filename: 'fixture.epub',
      mediaType: 'application/epub+zip',
      data: epubFixtureBuffer(),
    };

    const rendered = epubRenderedPreview(state, '');

    expect(rendered).toContain('equation-image image-width-45');
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
    reset: () => undefined,
    selectFiles: () => undefined,
    cancel: () => undefined,
    convert: () => undefined,
    download: () => undefined,
    setOutputFilename: () => undefined,
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
    setAuthors: () => undefined,
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
