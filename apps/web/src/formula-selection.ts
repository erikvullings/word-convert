import m from 'mithril';
import type { PdfBounds } from '@wordconvert/pdf-reader';
import type { AppState } from './state.ts';

export interface FormulaSelectionPoint {
  x: number;
  top: number;
}

export interface FormulaSelectionController {
  state: AppState;
  openFormulaSelection?(): void;
  cancelFormulaSelection?(): void;
  setFormulaSelectionKind?(kind: 'inline' | 'display'): void;
  beginFormulaSelection?(point: FormulaSelectionPoint): void;
  updateFormulaSelection?(point: FormulaSelectionPoint): void;
  endFormulaSelection?(point: FormulaSelectionPoint): void;
  setFormulaSelectionBounds?(bounds: PdfBounds): void;
  addManualFormulaRegion?(): void;
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
        m('p.help', 'Drag over the formula or enter page percentages below.'),
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
            tabindex: 0,
            role: 'group',
            'aria-label': `Select a formula region on PDF page ${preview.pageNumber}`,
            onpointerdown: (event: PointerEvent) => {
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
            bounds
              ? m(
                  '.formula-selection-box',
                  {
                    style: {
                      left: `${bounds.x * 100}%`,
                      top: `${bounds.top * 100}%`,
                      width: `${bounds.width * 100}%`,
                      height: `${bounds.height * 100}%`,
                    },
                  },
                  'Selected formula region',
                )
              : null,
          ],
        )
      : m('p[role="status"]', 'Loading the current PDF page for selection.'),
    m('fieldset.formula-selection-fields', { disabled: !preview }, [
      m('legend', 'Region percentages'),
      percentageField(controller, 'Left', 'x'),
      percentageField(controller, 'Top', 'top'),
      percentageField(controller, 'Width', 'width'),
      percentageField(controller, 'Height', 'height'),
    ]),
    m(
      'button',
      {
        type: 'button',
        disabled: !bounds || state.status === 'analysing',
        onclick: () => controller.addManualFormulaRegion?.(),
      },
      'Recognize selected formula',
    ),
  ]);
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

function percentageField(
  controller: FormulaSelectionController,
  label: string,
  key: keyof PdfBounds,
): m.Vnode {
  const current = controller.state.formulaSelectionBounds ?? {
    x: 0.1,
    top: 0.1,
    width: 0.3,
    height: 0.1,
  };
  return m('label', [
    m('span', label),
    m('input', {
      type: 'number',
      min: 0,
      max: 100,
      step: 0.5,
      value: Math.round(current[key] * 1_000) / 10,
      oninput: (event: Event) => {
        const value =
          Number((event.currentTarget as HTMLInputElement).value) / 100;
        controller.setFormulaSelectionBounds?.(
          boundedRegion({ ...current, [key]: value }),
        );
      },
    }),
  ]);
}

function boundedRegion(bounds: PdfBounds): PdfBounds {
  const x = clamp(bounds.x);
  const top = clamp(bounds.top);
  return {
    x,
    top,
    width: Math.min(1 - x, Math.max(0.01, bounds.width)),
    height: Math.min(1 - top, Math.max(0.01, bounds.height)),
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
