import m, { type Component } from 'mithril';
import type {
  EffectiveFormatting,
  Person,
  StyleMapping,
} from '@wordconvert/document-model';
import {
  Button,
  LinearProgress,
  ThemeSwitcher,
  type Theme,
} from 'mithril-materialized';

import {
  DOCX_MEDIA_TYPE,
  WORKFLOW_STAGES,
  type AppState,
  type ThemePreference,
} from './state.ts';
import { STYLE_MAPPINGS, type EditableMetadataField } from './editors.ts';

export interface AppController {
  state: AppState;
  selectFiles(files: FileList | File[]): void;
  cancel(): void;
  convert(): void;
  download(): void;
  setTheme(theme: ThemePreference): void;
  setOutputFormat(format: 'html' | 'markdown'): void;
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
      m(ThemeSwitcher, {
        theme: toMaterialTheme(controller.state.preferences.theme),
        showLabels: true,
        onThemeChange: (theme: Theme) =>
          controller.setTheme(fromMaterialTheme(theme)),
      }),
    ]),
    m(
      'p.privacy-note',
      'All processing stays on this device. Your document is never uploaded or stored.',
    ),
    m(
      'nav.workflow[aria-label="Conversion workflow"]',
      m(
        'ol',
        WORKFLOW_STAGES.map((stage, index) =>
          m(
            'li',
            {
              class:
                index === controller.state.stage
                  ? 'active'
                  : index < controller.state.stage
                    ? 'done'
                    : '',
            },
            [m('span.stage-number', String(index + 1)), m('span', stage)],
          ),
        ),
      ),
    ),
    m('main.workspace', [
      m('section.panel', [
        m('h2', WORKFLOW_STAGES[controller.state.stage] ?? WORKFLOW_STAGES[0]),
        controller.state.stage === 0
          ? filePicker(select, drop)
          : stageContent(controller),
        controller.state.error
          ? m('div.error[role="alert"]', controller.state.error.message)
          : null,
        controller.state.progress ? progress(controller) : null,
      ]),
      m('aside.summary', [
        m('h2', 'Session'),
        m('dl', [
          m('dt', 'Document'),
          m('dd', controller.state.selectedFilename ?? 'None selected'),
          m('dt', 'Output'),
          m('dd', controller.state.preferences.outputFormat.toUpperCase()),
          m('dt', 'Storage'),
          m('dd', 'Preferences only'),
        ]),
      ]),
    ]),
  ]);
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
  if (state.stage === 1)
    return m(
      'p',
      state.status === 'analysing'
        ? 'Inspecting the document package…'
        : 'Analysis complete.',
    );
  if (state.stage === 2) return styleEditor(controller);
  if (state.stage === 3) return metadataEditor(controller);
  if (state.stage === 4)
    return m('div', [
      m('fieldset.output-options', [
        m('legend', 'Download format'),
        ...(['html', 'markdown'] as const).map((format) =>
          m('label', [
            m('input', {
              type: 'radio',
              name: 'format',
              value: format,
              checked: state.preferences.outputFormat === format,
              onchange: () => controller.setOutputFormat(format),
            }),
            format === 'html'
              ? 'Standalone HTML'
              : 'Markdown with embedded images',
          ]),
        ),
      ]),
      m(Button, {
        label: 'Continue',
        onclick: () => {
          state.stage += 1;
        },
      }),
    ]);
  if (state.stage === 5)
    return continuePanel(
      'EPUB cover configuration becomes available when EPUB output is enabled.',
      state,
    );
  if (state.stage === 6)
    return m('div', [
      m('p', 'The analysed document is ready to convert.'),
      m(Button, {
        label: 'Continue to conversion',
        onclick: () => {
          state.stage = 7;
        },
      }),
    ]);
  return m('div.actions', [
    state.output
      ? m(Button, {
          label: `Download ${state.output.filename}`,
          onclick: () => controller.download(),
        })
      : m(Button, {
          label: 'Convert document',
          onclick: () => controller.convert(),
          disabled: state.status === 'converting',
        }),
  ]);
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
      'div.table-scroll[tabindex="0"][aria-label="Style mapping table"]',
      m('table.style-table', [
        m(
          'thead',
          m('tr', [
            m('th[scope="col"]', 'Style'),
            m('th[scope="col"]', 'Proposal'),
            m('th[scope="col"]', 'Confidence and reasons'),
            m('th[scope="col"]', 'Samples'),
            m('th[scope="col"]', 'Formatting'),
            m('th[scope="col"]', 'Mapping'),
          ]),
        ),
        m(
          'tbody',
          (state.model?.styles ?? []).map((style) =>
            m('tr', { key: style.id }, [
              m('th[scope="row"]', [
                style.name ?? style.id,
                m('small', style.id),
              ]),
              m('td', mappingLabel(style.proposedMapping)),
              m('td', [
                m('strong', style.provenance.confidence),
                m(
                  'ul',
                  style.reasons.map((reason) => m('li', reason)),
                ),
              ]),
              m('td', [
                m('span', `${style.usageCount} uses`),
                ...style.examples.map((sample) => m('q.sample', sample)),
              ]),
              m('td', formattingSummary(style.formatting)),
              m(
                'td',
                m('label.sr-label', [
                  m('span.sr-only', `Mapping for ${style.name ?? style.id}`),
                  m(
                    'select',
                    {
                      value:
                        state.styleMappings[style.id] ?? style.proposedMapping,
                      onchange: (event: Event) =>
                        controller.setStyleMapping(
                          style.id,
                          (event.currentTarget as HTMLSelectElement)
                            .value as StyleMapping,
                        ),
                    },
                    STYLE_MAPPINGS.map((mapping) =>
                      m('option', { value: mapping }, mappingLabel(mapping)),
                    ),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ]),
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
      label: 'Continue to metadata',
      onclick: () => {
        state.stage = 3;
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
      label: 'Continue to output',
      onclick: () => {
        controller.state.stage = 4;
      },
    }),
  ]);
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

function continuePanel(message: string, state: AppState): m.Vnode {
  return m('div', [
    m('p', message),
    m(Button, {
      label: 'Continue',
      onclick: () => {
        state.stage += 1;
      },
    }),
  ]);
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

function toMaterialTheme(theme: ThemePreference): Theme {
  return theme === 'system' ? 'auto' : theme;
}

function fromMaterialTheme(theme: Theme): ThemePreference {
  return theme === 'auto' ? 'system' : theme;
}
