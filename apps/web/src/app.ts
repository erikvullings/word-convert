import m, { type Component } from 'mithril';
import type {
  DocumentMetadata,
  EffectiveFormatting,
  Person,
  StyleMapping,
} from '@wordconvert/document-model';
import {
  Button,
  LinearProgress,
  RadioButtons,
  Select,
} from 'mithril-materialized';
import DOMPurify from 'dompurify';
import { strFromU8, unzipSync } from 'fflate';
import { render as renderMarkdown } from 'slimdown-js';

import {
  DOCX_MEDIA_TYPE,
  WORKFLOW_STAGES,
  type AppState,
  type PreviewMode,
  type ThemePreference,
} from './state.ts';
import { STYLE_MAPPINGS, type EditableMetadataField } from './editors.ts';

const styleMappingOptions = STYLE_MAPPINGS.map((mapping) => ({
  id: mapping,
  label: mappingLabel(mapping),
}));
const previewModeOptions = [
  { id: 'rendered' as const, label: 'Rendered' },
  { id: 'source' as const, label: 'Markdown' },
];

export interface AppController {
  state: AppState;
  selectFiles(files: FileList | File[]): void;
  cancel(): void;
  convert(): void;
  download(): void;
  setTheme(theme: ThemePreference): void;
  setOutputFormat(format: 'html' | 'markdown' | 'epub'): void;
  setStyleMapping(styleId: string, mapping: StyleMapping): void;
  acceptHighConfidence(): void;
  rerunAnalysis(): void;
  setPresetText(value: string): void;
  importPreset(): void;
  exportPreset(): void;
  savePreset(name: string): void;
  loadPreset(name: string): void;
  setMetadata(field: EditableMetadataField, value: string): void;
  setSubjects(value: string): void;
  addAuthor(): void;
  updateAuthor(index: number, person: Person): void;
  removeAuthor(index: number): void;
}

export function App(controller: AppController): Component {
  const select = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files) controller.selectFiles(input.files);
  };
  const drop = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer?.files)
      controller.selectFiles(event.dataTransfer.files);
  };

  return {
    view: () => renderApp(controller, select, drop),
  };
}

export function renderApp(
  controller: AppController,
  select: (event: Event) => void = () => undefined,
  drop: (event: DragEvent) => void = () => undefined,
): m.Vnode {
  return m('div.app', { 'data-theme': controller.state.preferences.theme }, [
    m('header.app-header', [
      m('div', [
        m('p.eyebrow', 'Private document conversion'),
        m('h1', 'WordConvert'),
      ]),
      themeToggle(controller),
    ]),
    m(
      'p.privacy-note',
      'All processing stays on this device. Your document is never uploaded or stored.',
    ),
    m('main.workspace', [
      m('section.panel', [
        m('h2', WORKFLOW_STAGES[controller.state.stage] ?? WORKFLOW_STAGES[0]),
        controller.state.selectedFilename
          ? m('p.document-context', documentLabel(controller.state))
          : null,
        controller.state.stage === 0
          ? filePicker(select, drop)
          : stageContent(controller),
        controller.state.error
          ? m('div.error[role="alert"]', controller.state.error.message)
          : null,
        controller.state.progress ? progress(controller) : null,
      ]),
    ]),
  ]);
}

function documentLabel(state: AppState): string {
  return (
    state.model?.metadata.title?.value.trim() || state.selectedFilename || ''
  );
}

function filePicker(
  onchange: (event: Event) => void,
  ondrop: (event: DragEvent) => void,
): m.Vnode {
  return m(
    'div.drop-zone',
    {
      ondragover: (event: DragEvent) => event.preventDefault(),
      ondrop,
    },
    [
      m('label.file-label[for="docx-input"]', 'Choose a DOCX document'),
      m('input#docx-input', {
        type: 'file',
        accept: `${DOCX_MEDIA_TYPE},.docx`,
        onchange,
      }),
      m('p', 'or drag and drop a .docx file here'),
    ],
  );
}

function stageContent(controller: AppController): m.Children {
  const state = controller.state;
  if (state.review === 'styles') return styleEditor(controller);
  if (state.review === 'metadata') return metadataEditor(controller);
  if (state.stage === 1) return outputChooser(controller);
  if (state.stage === 2) return preview(controller);
  return downloadPanel(controller);
}

function outputChooser(controller: AppController): m.Vnode {
  const state = controller.state;
  if (state.status === 'analysing')
    return m('p', 'Inspecting the document in the background…');
  return m('div.output-chooser', [
    m('p', 'Analysis is complete. Choose how you want to use the document.'),
    m(
      'div.format-cards',
      (['markdown', 'html', 'epub'] as const).map((format) =>
        m(
          'button.format-card',
          {
            type: 'button',
            onclick: () => controller.setOutputFormat(format),
          },
          [
            m(
              'strong',
              format === 'html'
                ? 'HTML'
                : format === 'markdown'
                  ? 'Markdown'
                  : 'EPUB 3',
            ),
            m(
              'span',
              format === 'html'
                ? 'Preview directly in the browser'
                : format === 'markdown'
                  ? 'Rendered preview and Markdown source'
                  : 'Configure and inspect the publication package',
            ),
          ],
        ),
      ),
    ),
    m('p.secondary-actions', [
      'Something looks wrong? ',
      m(
        'button.link-button',
        {
          type: 'button',
          onclick: () => openReview(state, 'styles'),
        },
        'Review style mapping',
      ),
      ' or ',
      m(
        'button.link-button',
        {
          type: 'button',
          onclick: () => openReview(state, 'metadata'),
        },
        'review metadata',
      ),
      '.',
    ]),
  ]);
}

function epubConfiguration(controller: AppController): m.Vnode {
  const metadata = controller.state.model?.metadata;
  const issues = epubMetadataIssues(metadata);
  return m('section.epub-config', [
    m('h3', 'EPUB configuration'),
    m(
      'p',
      'The title, language, identifier, and authors come from the analysed document metadata.',
    ),
    m('label', [
      m('span', 'Cover image (optional)'),
      m('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp',
        onchange: (event: Event) => {
          const files = (event.currentTarget as HTMLInputElement).files;
          if (files?.[0] && issues.length === 0) controller.convert();
        },
      }),
      m(
        'small',
        'Cover embedding is not yet enabled; the selected file stays on this device.',
      ),
    ]),
    issues.length
      ? m('p.error[role="alert"]', [
          `Update required EPUB metadata: ${issues.join('; ')}. `,
          m(
            'button.link-button',
            {
              type: 'button',
              onclick: () => openReview(controller.state, 'metadata'),
            },
            'Review metadata',
          ),
        ])
      : m(
          'p',
          controller.state.status === 'converting'
            ? 'Refreshing EPUB preview…'
            : 'EPUB preview updates automatically when metadata changes.',
        ),
  ]);
}

function epubMetadataIssues(metadata?: DocumentMetadata): string[] {
  const title = metadata?.title?.value.trim() ?? '';
  const language = metadata?.language?.value.trim() ?? '';
  const identifier = metadata?.identifier?.value.trim() ?? '';
  const issues: string[] = [];
  if (!title) issues.push('title is missing');
  if (!language) issues.push('language is missing');
  else if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language))
    issues.push('language must be a BCP 47 tag (for example en or en-GB)');
  if (!identifier) issues.push('identifier is missing');
  return issues;
}

function preview(controller: AppController): m.Vnode {
  const state = controller.state;
  if (state.preferences.outputFormat === 'epub')
    return m('div.preview-panel', [
      previewActions(controller),
      epubConfiguration(controller),
      epubLayoutPreview(controller),
      previewActions(controller),
    ]);

  if (!state.output)
    return m('div', [
      m(
        'p',
        state.status === 'converting'
          ? 'Creating preview…'
          : 'No preview is available.',
      ),
      m(Button, {
        label: 'Back to formats',
        onclick: () => {
          state.stage = 1;
        },
      }),
    ]);
  const source = new TextDecoder().decode(state.output.data);
  const isMarkdown = state.preferences.outputFormat === 'markdown';
  const rendered = isMarkdown ? renderMarkdown(source) : source;
  const previewMarkup = isMarkdown ? rendered : extractHtmlBody(rendered);
  return m('div.preview-panel', [
    previewActions(controller),
    isMarkdown
      ? m(
          'div.preview-mode',
          m(RadioButtons<PreviewMode>, {
            // label: 'Preview mode',
            id: 'markdown-preview-mode',
            options: previewModeOptions,
            checkedId: state.previewMode,
            className: 'row',
            checkboxClass: 'col s6',
            onchange: (mode) => {
              state.previewMode = mode;
            },
          }),
        )
      : null,
    isMarkdown && state.previewMode === 'source'
      ? m('pre.markdown-source', source)
      : m(
          'article.document-preview',
          m.trust(
            DOMPurify.sanitize(previewMarkup, {
              FORBID_TAGS: ['style', 'link', 'meta', 'title'],
              FORBID_ATTR: ['style'],
            }),
          ),
        ),
    previewActions(controller),
  ]);
}

const epubFileOrder = (a: string, b: string): number => {
  // Sort priority: title, nav, chapters, images, mimetype, META-INF, styles, package
  const getPriority = (file: string): number => {
    const lower = file.toLowerCase();
    if (lower.includes('title')) return 0;
    if (lower.includes('nav')) return 1;
    if (lower.includes('chapter')) return 2;
    if (lower.includes('image')) return 3;
    if (lower === 'mimetype') return 4;
    if (lower.includes('meta-inf')) return 5;
    if (lower.includes('styles') || lower.endsWith('.css')) return 6;
    if (lower.includes('package') || lower.endsWith('.opf')) return 7;
    return 8; // Other files
  };
  const aPri = getPriority(a);
  const bPri = getPriority(b);
  if (aPri !== bPri) return aPri - bPri;
  return a.localeCompare(b); // Alphabetical as tiebreaker
};

function epubLayoutPreview(controller: AppController): m.Vnode {
  const state = controller.state;
  if (!state.output)
    return m(
      'p',
      state.status === 'converting'
        ? 'Creating preview…'
        : 'No preview is available yet.',
    );

  const archive = unzipSync(new Uint8Array(state.output.data));
  const files = (
    state.output.files?.filter((file) => archive[file] !== undefined) ??
    Object.keys(archive)
  ).sort(epubFileOrder);
  const selected =
    state.selectedEpubFile && files.includes(state.selectedEpubFile)
      ? state.selectedEpubFile
      : files[0];
  if (selected && selected !== state.selectedEpubFile)
    state.selectedEpubFile = selected;

  return m('section.epub-layout', [
    m('h3', 'EPUB file layout'),
    m('div.epub-layout-grid', [
      m(
        'ul.file-layout.epub-file-list',
        files.map((file) =>
          m('li', [
            m(
              'button.epub-file-button',
              {
                type: 'button',
                'aria-pressed': file === selected,
                ...(file === selected
                  ? { class: 'epub-file-button-selected' }
                  : {}),
                onclick: () => {
                  state.selectedEpubFile = file;
                },
              },
              m('code', file),
            ),
          ]),
        ),
      ),
      m('div.epub-file-viewer', renderEpubFilePreview(selected, archive)),
    ]),
  ]);
}

function renderEpubFilePreview(
  filename: string | undefined,
  archive: Record<string, Uint8Array>,
): m.Children {
  if (!filename) return m('p', 'No EPUB files are available.');
  const data = archive[filename];
  if (!data) return m('p', 'The selected file is not available.');
  const lower = filename.toLowerCase();
  if (
    lower.endsWith('.xhtml') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm')
  ) {
    const source = strFromU8(data);
    let html = extractHtmlBody(source);
    // Replace <nav> tags with <div> to avoid CSS constraints
    html = html.replace(/<nav\b/gi, '<div').replace(/<\/nav\s*>/gi, '</div>');
    return m(
      'article.document-preview',
      m.trust(
        DOMPurify.sanitize(html, {
          FORBID_TAGS: ['style', 'link', 'meta', 'title'],
          FORBID_ATTR: ['style'],
        }),
      ),
    );
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.gif')
  ) {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i] as number);
    }
    return m('div.image-preview', [
      m('img', {
        src: `data:${mimeTypeForImage(filename)};base64,${btoa(binary)}`,
        alt: filename,
        style: 'max-width: 100%; height: auto;',
      }),
    ]);
  }
  if (
    lower.endsWith('.opf') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.css') ||
    lower.endsWith('.ncx') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.svg')
  )
    return m('pre.markdown-source', strFromU8(data));
  return m(
    'p',
    `Binary asset preview is not rendered for ${filename} (${data.byteLength} bytes).`,
  );
}

function mimeTypeForImage(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

export function extractHtmlBody(source: string): string {
  return /<body(?:\s[^>]*)?>([\s\S]*?)<\/body\s*>/i.exec(source)?.[1] ?? source;
}

function previewActions(controller: AppController): m.Vnode {
  const state = controller.state;
  return m('div.preview-actions', [
    m(Button, {
      label: `Download ${state.output?.filename ?? 'output'}`,
      disabled: !state.output,
      onclick: () => controller.download(),
    }),
    m(
      'button.link-button',
      {
        type: 'button',
        onclick: () => openReview(state, 'styles'),
      },
      'Review style mapping',
    ),
    m(
      'button.link-button',
      {
        type: 'button',
        onclick: () => openReview(state, 'metadata'),
      },
      'Review metadata',
    ),
    m(
      'button.link-button',
      {
        type: 'button',
        onclick: () => {
          if (typeof history !== 'undefined') history.back();
          else {
            state.stage = 1;
            delete state.output;
          }
        },
      },
      'Choose another format',
    ),
  ]);
}

function downloadPanel(controller: AppController): m.Vnode {
  return m('div', [
    m('p', 'Your converted document is ready.'),
    m(Button, {
      label: `Download ${controller.state.output?.filename ?? 'document'}`,
      onclick: () => controller.download(),
    }),
  ]);
}

function themeToggle(controller: AppController): m.Vnode {
  const dark = controller.state.preferences.theme === 'dark';
  return m(
    'button.theme-toggle',
    {
      type: 'button',
      title: dark ? 'Use light theme' : 'Use dark theme',
      'aria-label': dark ? 'Use light theme' : 'Use dark theme',
      onclick: () => controller.setTheme(dark ? 'light' : 'dark'),
    },
    dark ? '☀' : '☾',
  );
}

function styleEditor(controller: AppController): m.Vnode {
  const state = controller.state;
  const presetNames = Object.keys(state.preferences.mappingPresets);
  return m('div.editor', [
    m('div.editor-toolbar', [
      m(Button, {
        label: 'Accept high-confidence proposals',
        onclick: () => controller.acceptHighConfidence(),
      }),
      m(Button, {
        label: 'Rerun analysis with mappings',
        onclick: () => controller.rerunAnalysis(),
        disabled: state.status === 'analysing',
      }),
    ]),
    m(
      'div.style-review-list[aria-label="Style mapping table"]',
      (state.model?.styles ?? []).map((style) => {
        const name = style.name ?? style.id;
        return m('article.style-review-card', { key: style.id }, [
          m('header.style-card-identity', [m('h3', name), m('code', style.id)]),
          m('section.style-card-proposal', [
            m('span.card-label', 'Proposal'),
            m('strong', mappingLabel(style.proposedMapping)),
          ]),
          m('section.style-card-evidence', [
            m('span.card-label', 'Evidence'),
            m('strong', `${style.provenance.confidence} confidence`),
            m(
              'ul',
              style.reasons.map((reason) => m('li', reason)),
            ),
            m('span.usage-count', `${style.usageCount} uses`),
            ...style.examples.map((sample) => m('q.sample', sample)),
          ]),
          m('section.style-card-formatting', [
            m('span.card-label', 'Formatting'),
            formattingSummary(style.formatting),
          ]),
          m(
            'section.style-card-mapping',
            m(StyleMappingControl, {
              key: style.id,
              id: `style-mapping-${style.id}`,
              label: `Mapping for ${name}`,
              options: styleMappingOptions,
              checkedId: state.styleMappings[style.id] ?? style.proposedMapping,
              onchange: (checkedIds: StyleMapping[]) => {
                const mapping = checkedIds[0];
                if (mapping) controller.setStyleMapping(style.id, mapping);
              },
            }),
          ),
        ]);
      }),
    ),
    m('fieldset.preset-editor', [
      m('legend', 'JSON presets'),
      m(
        'p.help',
        'Only version 1 WordConvert style presets are accepted. JSON is displayed as plain text.',
      ),
      m('label', [
        'Preset JSON',
        m('textarea', {
          value: state.presetText,
          rows: 7,
          oninput: (event: Event) =>
            controller.setPresetText(
              (event.currentTarget as HTMLTextAreaElement).value,
            ),
        }),
      ]),
      m('div.editor-toolbar', [
        m(Button, {
          label: 'Import JSON',
          onclick: () => controller.importPreset(),
        }),
        m(Button, {
          label: 'Export JSON',
          onclick: () => controller.exportPreset(),
        }),
      ]),
      m('label', [
        'Saved preset',
        m(
          'select',
          {
            onchange: (event: Event) =>
              controller.loadPreset(
                (event.currentTarget as HTMLSelectElement).value,
              ),
          },
          [
            m('option', { value: '' }, 'Choose preset'),
            ...presetNames.map((name) => m('option', { value: name }, name)),
          ],
        ),
      ]),
      m('label', ['New preset name', m('input#preset-name', { type: 'text' })]),
      m(Button, {
        label: 'Save preset',
        onclick: () => {
          const input =
            document.querySelector<HTMLInputElement>('#preset-name');
          controller.savePreset(input?.value ?? '');
        },
      }),
      state.editorNotice ? m('p[role="status"]', state.editorNotice) : null,
    ]),
    m(Button, {
      label: 'Back',
      onclick: () => {
        navigateBackFromReview(state, () => {
          if (state.output) controller.convert();
        });
      },
    }),
  ]);
}

const METADATA_FIELDS: readonly [EditableMetadataField, string, string][] = [
  ['title', 'Title', 'text'],
  ['subtitle', 'Subtitle', 'text'],
  ['language', 'Language', 'text'],
  ['publisher', 'Publisher', 'text'],
  ['description', 'Description', 'textarea'],
  ['version', 'Version', 'text'],
  ['sourceCreatedAt', 'Source created date', 'date'],
  ['sourceModifiedAt', 'Source modified date', 'date'],
  ['publicationDate', 'Publication date', 'date'],
  ['conversionDate', 'Conversion date', 'date'],
  ['identifier', 'Identifier', 'text'],
  ['rights', 'Rights', 'textarea'],
];

function metadataEditor(controller: AppController): m.Vnode {
  const metadata = controller.state.model?.metadata;
  if (!metadata) return m('p', 'No metadata is available.');
  return m('div.editor.metadata-editor', [
    m(
      'p.help',
      'Review values with their source, confidence, and whether they are inferred, defaulted, or edited.',
    ),
    ...METADATA_FIELDS.map(([field, label, type]) =>
      metadataField(controller, field, label, type),
    ),
    m('label.metadata-field', [
      m('span', 'Subjects (comma separated)'),
      m('input', {
        value: metadata.subjects.map(({ value }) => value).join(', '),
        oninput: (event: Event) =>
          controller.setSubjects(
            (event.currentTarget as HTMLInputElement).value,
          ),
      }),
      provenance(metadata.subjects[0]),
    ]),
    m('fieldset.authors', [
      m('legend', 'Authors'),
      ...metadata.authors.map((author, index) =>
        authorEditor(controller, author.value, index, author),
      ),
      m(Button, { label: 'Add author', onclick: () => controller.addAuthor() }),
    ]),
    m(Button, {
      label: 'Back',
      onclick: () => {
        navigateBackFromReview(controller.state, () => {
          if (controller.state.output) controller.convert();
        });
      },
    }),
  ]);
}

function openReview(state: AppState, review: 'styles' | 'metadata'): void {
  state.review = review;
  if (typeof history !== 'undefined') {
    history.pushState(
      {
        stage: state.stage,
        format: state.preferences.outputFormat,
        review,
      },
      '',
      window.location.href,
    );
  }
}

function navigateBackFromReview(state: AppState, fallback: () => void): void {
  if (typeof history !== 'undefined') {
    history.back();
    return;
  }
  delete state.review;
  fallback();
}

function metadataField(
  controller: AppController,
  field: EditableMetadataField,
  label: string,
  type: string,
): m.Vnode {
  const inferred = controller.state.model?.metadata[field];
  const value = inferred && 'value' in inferred ? String(inferred.value) : '';
  const attributes = {
    value,
    oninput: (event: Event) =>
      controller.setMetadata(
        field,
        (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value,
      ),
  };
  return m('label.metadata-field', [
    m('span', label),
    type === 'textarea'
      ? m('textarea', attributes)
      : m('input', { ...attributes, type }),
    provenance(inferred && 'provenance' in inferred ? inferred : undefined),
  ]);
}

function authorEditor(
  controller: AppController,
  person: Person,
  index: number,
  inferred: {
    provenance: { source: string; confidence: string; method: string };
  },
): m.Vnode {
  const update = (field: keyof Person, value: string): void =>
    controller.updateAuthor(index, { ...person, [field]: value });
  return m('div.author-card', [
    ...(
      [
        ['name', 'Name'],
        ['sortAs', 'Sort as'],
        ['role', 'Role'],
        ['identifier', 'Identifier'],
      ] as const
    ).map(([field, label]) =>
      m('label', [
        label,
        m('input', {
          value: person[field] ?? '',
          oninput: (event: Event) =>
            update(field, (event.currentTarget as HTMLInputElement).value),
        }),
      ]),
    ),
    provenance(inferred),
    m(Button, {
      label: `Remove author ${index + 1}`,
      onclick: () => controller.removeAuthor(index),
    }),
  ]);
}

function provenance(value?: {
  provenance: { source: string; confidence: string; method: string };
}): m.Vnode {
  return m(
    'small.provenance',
    value
      ? `${value.provenance.method} · ${value.provenance.confidence} · ${value.provenance.source}`
      : 'Not provided',
  );
}

function mappingLabel(mapping: StyleMapping): string {
  return mapping
    .replace(/heading(\d)/, 'Heading $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formattingSummary(formatting: EffectiveFormatting): string {
  const values = Object.entries(formatting)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return values.length ? values.join(', ') : 'No explicit formatting';
}

function progress(controller: AppController): m.Vnode {
  const state = controller.state;
  const total = state.progress?.total;
  const completed = state.progress?.completed ?? 0;
  const value = total ? (completed / total) * 100 : undefined;
  return m('div.progress-status[aria-live="polite"]', [
    m(LinearProgress, {
      mode: value === undefined ? 'indeterminate' : 'determinate',
      ...(value === undefined ? {} : { value }),
      'aria-label': state.progress?.message ?? 'Document processing progress',
    }),
    m(
      'p',
      state.progress?.message ?? `Processing: ${state.progress?.phase ?? ''}`,
    ),
    m(Button, { label: 'Cancel', onclick: () => controller.cancel() }),
  ]);
}

interface StyleMappingControlAttrs {
  key?: string;
  id: string;
  label: string;
  options: typeof styleMappingOptions;
  checkedId: StyleMapping;
  onchange(checkedIds: StyleMapping[]): void;
}

const StyleMappingControl: m.FactoryComponent<
  StyleMappingControlAttrs
> = () => {
  const RowSelect = Select<StyleMapping>();
  return { view: ({ attrs }) => m(RowSelect, attrs) };
};
