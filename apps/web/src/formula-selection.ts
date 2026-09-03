import m from 'mithril';
import type { PdfBounds } from '@wordconvert/pdf-reader';
import { isValidTex } from '@wordconvert/math-converter';
import type { AppState } from './state.ts';

export interface FormulaSelectionPoint {
  x: number;
  top: number;
}

export type FormulaSelectionHandle =
  'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface FormulaSelectionController {
  state: AppState;
  openFormulaSelection?(): void;
  cancelFormulaSelection?(): void;
  setFormulaSelectionKind?(kind: 'inline' | 'display'): void;
  beginFormulaSelection?(point: FormulaSelectionPoint): void;
  beginFormulaSelectionAdjustment?(
    handle: FormulaSelectionHandle,
    point: FormulaSelectionPoint,
  ): void;
  updateFormulaSelection?(point: FormulaSelectionPoint): void;
  endFormulaSelection?(point: FormulaSelectionPoint): void;
  setFormulaSelectionBounds?(bounds: PdfBounds): void;
  setFormulaSelectionTex?(tex: string): void;
  addManualFormulaRegion?(tex?: string): void;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pointInPreview(
  clientX: number,
  clientY: number,
  rectangle: RectLike,
): FormulaSelectionPoint {
  return {
    x: clamp((clientX - rectangle.left) / Math.max(1, rectangle.width)),
    top: clamp((clientY - rectangle.top) / Math.max(1, rectangle.height)),
  };
}

export function normalizeFormulaSelection(
  start: FormulaSelectionPoint,
  end: FormulaSelectionPoint,
  minimumDimension = 0.01,
): PdfBounds | undefined {
  const startX = clamp(start.x);
  const startTop = clamp(start.top);
  const endX = clamp(end.x);
  const endTop = clamp(end.top);
  const bounds = {
    x: Math.min(startX, endX),
    top: Math.min(startTop, endTop),
    width: Math.abs(endX - startX),
    height: Math.abs(endTop - startTop),
  };
  return bounds.width >= minimumDimension && bounds.height >= minimumDimension
    ? bounds
    : undefined;
}

export function adjustFormulaSelection(
  initial: PdfBounds,
  start: FormulaSelectionPoint,
  current: FormulaSelectionPoint,
  handle: FormulaSelectionHandle,
  minimumDimension = 0.01,
): PdfBounds {
  const deltaX = current.x - start.x;
  const deltaTop = current.top - start.top;
  if (handle === 'move')
    return {
      ...initial,
      x: Math.min(1 - initial.width, Math.max(0, initial.x + deltaX)),
      top: Math.min(1 - initial.height, Math.max(0, initial.top + deltaTop)),
    };
  let left = initial.x;
  let top = initial.top;
  let right = initial.x + initial.width;
  let bottom = initial.top + initial.height;
  if (handle.includes('w'))
    left = Math.min(right - minimumDimension, Math.max(0, left + deltaX));
  if (handle.includes('e'))
    right = Math.max(left + minimumDimension, Math.min(1, right + deltaX));
  if (handle.includes('n'))
    top = Math.min(bottom - minimumDimension, Math.max(0, top + deltaTop));
  if (handle.includes('s'))
    bottom = Math.max(top + minimumDimension, Math.min(1, bottom + deltaTop));
  return { x: left, top, width: right - left, height: bottom - top };
}

export function selectionScrollOffset(
  normalizedPosition: number,
  scrollExtent: number,
  viewportExtent: number,
): number {
  return Math.min(
    Math.max(0, scrollExtent - viewportExtent),
    Math.max(0, normalizedPosition * scrollExtent - viewportExtent / 2),
  );
}

export function manualFormulaRegionId(page: number, bounds: PdfBounds): string {
  const values = [bounds.x, bounds.top, bounds.width, bounds.height].map(
    (value) => Math.round(clamp(value) * 10_000),
  );
  return `pdf-equation-manual-p${page}-${values.join('-')}`;
}

export function formulaSelectionEditor(
  controller: FormulaSelectionController,
): m.Vnode {
  const { state } = controller;
  if (!state.formulaSelectionOpen)
    return m(
      'button.formula-selection-open',
      { type: 'button', onclick: () => controller.openFormulaSelection?.() },
      'Add missed formula',
    );
  const preview = state.pdfPreview;
  const bounds = state.formulaSelectionBounds;
  const normalizedTex = state.formulaSelectionTex.trim();
  const validTex =
    normalizedTex !== '' &&
    isValidTex(normalizedTex, state.formulaSelectionKind === 'display');
  const pointer = (event: PointerEvent) =>
    pointInPreview(
      event.clientX,
      event.clientY,
      (event.currentTarget as HTMLElement).getBoundingClientRect(),
    );
  return m('section.formula-selection[aria-label="Add missed formula"]', [
    m('header', [
      m('div', [
        m('h4', 'Add missed formula'),
        m(
          'p.help',
          'Drag over a formula, then move or resize the selected region.',
        ),
      ]),
      m(
        'button',
        {
          type: 'button',
          onclick: () => controller.cancelFormulaSelection?.(),
        },
        'Cancel selection',
      ),
    ]),
    m('.formula-selection-kind[role="group"][aria-label="Formula layout"]', [
      selectionKindButton(controller, 'inline', 'Inline'),
      selectionKindButton(controller, 'display', 'Block'),
    ]),
    preview
      ? m(
          '.formula-selection-surface',
          {
            oncreate: (vnode) => {
              const surface = vnode.dom as HTMLElement;
              requestAnimationFrame(() => {
                if (!bounds) return;
                surface.scrollLeft = selectionScrollOffset(
                  bounds.x + bounds.width / 2,
                  surface.scrollWidth,
                  surface.clientWidth,
                );
                surface.scrollTop = selectionScrollOffset(
                  bounds.top + bounds.height / 2,
                  surface.scrollHeight,
                  surface.clientHeight,
                );
              });
            },
          },
          m(
            '.formula-selection-page',
            {
              tabindex: 0,
              role: 'group',
              'aria-label': `Select a formula region on PDF page ${preview.pageNumber}`,
              onpointerdown: (event: PointerEvent) => {
                if (
                  event.target !== event.currentTarget &&
                  (event.target as HTMLElement).tagName !== 'IMG'
                )
                  return;
                (event.currentTarget as HTMLElement).setPointerCapture(
                  event.pointerId,
                );
                controller.beginFormulaSelection?.(pointer(event));
              },
              onpointermove: (event: PointerEvent) => {
                if (event.buttons === 1)
                  controller.updateFormulaSelection?.(pointer(event));
              },
              onpointerup: (event: PointerEvent) =>
                controller.endFormulaSelection?.(pointer(event)),
            },
            [
              m('img', {
                src: preview.url,
                width: preview.width,
                height: preview.height,
                alt: `PDF page ${preview.pageNumber} for formula selection`,
              }),
              bounds ? selectionBox(controller, bounds) : null,
            ],
          ),
        )
      : m('p[role="status"]', 'Loading the current PDF page for selection.'),
    m('label.formula-selection-tex', [
      m('span', 'LaTeX (optional)'),
      previousFormulaSelect(state, (tex) =>
        controller.setFormulaSelectionTex?.(tex),
      ),
      m('input', {
        type: 'text',
        value: state.formulaSelectionTex,
        placeholder: String.raw`\sqrt{d_{k}}`,
        oninput: (event: Event) =>
          controller.setFormulaSelectionTex?.(
            (event.currentTarget as HTMLInputElement).value,
          ),
      }),
    ]),
    m('.formula-selection-actions', [
      m(
        'button',
        {
          type: 'button',
          disabled: !bounds || state.status === 'analysing',
          onclick: () => controller.addManualFormulaRegion?.(),
        },
        'Recognize selected formula',
      ),
      m(
        'button',
        {
          type: 'button',
          disabled: !bounds || !validTex || state.status === 'analysing',
          onclick: () => controller.addManualFormulaRegion?.(normalizedTex),
        },
        'Use typed formula',
      ),
    ]),
  ]);
}

function previousFormulaSelect(
  state: AppState,
  select: (tex: string) => void,
): m.Vnode | null {
  const formulas = [
    ...new Set(
      Object.values(state.model?.equations ?? {}).map(({ tex }) => tex),
    ),
  ];
  if (formulas.length === 0) return null;
  return m(
    'select',
    {
      'aria-label': 'Use previous formula',
      value: '',
      onchange: (event: Event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        if (value) select(value);
      },
    },
    [
      m('option', { key: '__choose__', value: '' }, 'Use previous formula...'),
      ...formulas.map((tex) => m('option', { key: tex, value: tex }, tex)),
    ],
  );
}

const RESIZE_HANDLES: readonly Exclude<FormulaSelectionHandle, 'move'>[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
];

function selectionBox(
  controller: FormulaSelectionController,
  bounds: PdfBounds,
): m.Vnode {
  const begin = (event: PointerEvent, handle: FormulaSelectionHandle) => {
    event.stopPropagation();
    const page = (event.currentTarget as HTMLElement).closest(
      '.formula-selection-page',
    ) as HTMLElement;
    page.setPointerCapture(event.pointerId);
    controller.beginFormulaSelectionAdjustment?.(
      handle,
      pointInPreview(
        event.clientX,
        event.clientY,
        page.getBoundingClientRect(),
      ),
    );
  };
  return m(
    '.formula-selection-box',
    {
      style: {
        left: `${bounds.x * 100}%`,
        top: `${bounds.top * 100}%`,
        width: `${bounds.width * 100}%`,
        height: `${bounds.height * 100}%`,
      },
      onpointerdown: (event: PointerEvent) => begin(event, 'move'),
    },
    RESIZE_HANDLES.map((handle) =>
      m(`button.formula-selection-handle.formula-selection-handle--${handle}`, {
        key: handle,
        type: 'button',
        'aria-label': `Resize selected formula region ${handle}`,
        onpointerdown: (event: PointerEvent) => begin(event, handle),
      }),
    ),
  );
}

function selectionKindButton(
  controller: FormulaSelectionController,
  kind: 'inline' | 'display',
  label: string,
): m.Vnode {
  return m(
    'button',
    {
      type: 'button',
      'aria-pressed':
        controller.state.formulaSelectionKind === kind ? 'true' : 'false',
      onclick: () => controller.setFormulaSelectionKind?.(kind),
    },
    label,
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
