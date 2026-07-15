import m, { type Component } from 'mithril';
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

export interface AppController {
  state: AppState;
  selectFiles(files: FileList | File[]): void;
  cancel(): void;
  convert(): void;
  download(): void;
  setTheme(theme: ThemePreference): void;
  setOutputFormat(format: 'html' | 'markdown'): void;
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
  if (state.stage === 2)
    return continuePanel(
      `${state.model?.styles.length ?? 0} used styles are ready for review.`,
      state,
    );
  if (state.stage === 3)
    return continuePanel(
      state.model?.metadata.title?.value ?? 'No title was inferred.',
      state,
    );
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
