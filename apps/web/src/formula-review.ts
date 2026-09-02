import m from 'mithril';
import DOMPurify from 'dompurify';
import type { Equation } from '@wordconvert/document-model';
import { isValidTex, renderTex } from '@wordconvert/math-converter';
import type {
  PdfFormulaCandidate,
  PdfFormulaDecision,
} from '@wordconvert/pdf-reader';
import type { AppState, FormulaReviewFilter } from './state.ts';
import { previewSanitizeConfig } from './preview/index.ts';

export type FormulaReviewStatus =
  'needs-review' | 'edited' | 'accepted' | 'rejected';

export interface FormulaReviewItem {
  id: string;
  candidate: PdfFormulaCandidate;
  equation?: Equation;
  decision?: PdfFormulaDecision;
  detectedTex: string;
  currentTex: string;
  status: FormulaReviewStatus;
}

export interface FormulaReviewController {
  state: AppState;
  setFormulaReviewFilter?(filter: FormulaReviewFilter): void;
  selectFormula?(equationId: string): void;
  setFormulaDraft?(equationId: string, tex: string): void;
  saveFormulaEdit?(equationId: string): void;
  resetFormulaEdit?(equationId: string): void;
  rejectFormula?(equationId: string): void;
  acceptFormula?(equationId: string): void;
  acceptHighConfidenceFormulas?(): void;
}

const FILTERS: readonly [FormulaReviewFilter, string][] = [
  ['all', 'All'],
  ['needs-review', 'Needs review'],
  ['edited', 'Edited'],
  ['accepted', 'Accepted'],
];

export function formulaReviewEditor(
  controller: FormulaReviewController,
): m.Vnode {
  const { state } = controller;
  const candidates = state.pdfAnalysis?.formulaCandidates ?? [];
  const allItems = formulaReviewItems(
    candidates,
    state.model?.equations ?? {},
    state.pdfImport.formulaDecisions,
    'all',
  );
  const items = formulaReviewItems(
    candidates,
    state.model?.equations ?? {},
    state.pdfImport.formulaDecisions,
    state.formulaReviewFilter,
  );
  const selected =
    items.find(({ id }) => id === state.formulaReviewSelectedId) ?? items[0];
  const busy = state.status === 'analysing';
  return m('section.editor.formula-review[aria-label="Formula Review"]', [
    m('header.formula-review-header', [
      m('div', [
        m('h3', 'Formula Review'),
        m('p.help', 'Compare each result with its PDF source before export.'),
      ]),
      m(
        'button',
        {
          type: 'button',
          disabled: busy || !allItems.some(isBulkEligible),
          onclick: () => controller.acceptHighConfidenceFormulas?.(),
        },
        'Accept all high-confidence formulas',
      ),
    ]),
    m(
      '.formula-review-filters[role="group"][aria-label="Formula review filter"]',
      FILTERS.map(([filter, label]) =>
        m(
          'button',
          {
            key: filter,
            type: 'button',
            'aria-pressed':
              state.formulaReviewFilter === filter ? 'true' : 'false',
            onclick: () => controller.setFormulaReviewFilter?.(filter),
          },
          label,
        ),
      ),
    ),
    items.length === 0
      ? m('p.formula-review-empty', 'No formulas match this filter.')
      : m('.formula-review-layout', [
          m(
            'ol.formula-review-list[aria-label="Formulas"]',
            items.map((item) => formulaReviewCard(controller, item, selected)),
          ),
          selected
            ? formulaReviewDetail(controller, selected, items, busy)
            : null,
        ]),
    m(
      'button.link-button',
      {
        type: 'button',
        onclick: () => {
          if (typeof history !== 'undefined') history.back();
          else delete state.review;
        },
      },
      'Back',
    ),
  ]);
}

function formulaReviewCard(
  controller: FormulaReviewController,
  item: FormulaReviewItem,
  selected: FormulaReviewItem | undefined,
): m.Vnode {
  const confidence =
    item.candidate.recognition?.reviewConfidence ?? item.candidate.confidence;
  return m(
    'li',
    { key: item.id },
    m(
      'button.formula-review-card',
      {
        type: 'button',
        'aria-current': selected?.id === item.id ? 'true' : undefined,
        onclick: () => controller.selectFormula?.(item.id),
      },
      [
        sourceRegion(controller, item, true),
        m('span.formula-card-page', `Page ${item.candidate.page}`),
        safeFormulaPreview(item.currentTex, item.candidate.kind === 'display'),
        m('code', item.currentTex),
        m('span', `${confidence} confidence`),
        m('span', methodLabel(item.equation?.recognition?.method)),
        m(
          'span',
          item.candidate.kind === 'display'
            ? 'Block formula'
            : 'Inline formula',
        ),
        m('strong', statusLabel(item.status)),
        recognitionWarning(item.candidate),
      ],
    ),
  );
}

function formulaReviewDetail(
  controller: FormulaReviewController,
  item: FormulaReviewItem,
  items: readonly FormulaReviewItem[],
  busy: boolean,
): m.Vnode {
  const { state } = controller;
  const draft = state.formulaDrafts[item.id] ?? item.currentTex;
  const validation = validateFormulaDraft(
    draft,
    item.candidate.kind === 'display',
  );
  const ids = items.map(({ id }) => id);
  const move = (offset: -1 | 1) => {
    const id = moveFormulaSelection(ids, item.id, offset);
    if (id) controller.selectFormula?.(id);
  };
  return m('article.formula-review-detail', [
    m('section.formula-source-panel', [
      m('h4', 'Original PDF region'),
      sourceRegion(controller, item, false),
    ]),
    m('section.formula-render-panel', [
      m('h4', 'Rendered formula'),
      validation.valid
        ? m.trust(sanitizeFormulaHtml(validation.html))
        : m('p.formula-validation-error[role="alert"]', validation.error),
    ]),
    m('label.formula-tex-field', [
      m('span', 'LaTeX'),
      m('textarea', {
        value: draft,
        rows: 5,
        'aria-invalid': validation.valid ? 'false' : 'true',
        'aria-describedby': `formula-error-${item.id}`,
        oninput: (event: Event) =>
          controller.setFormulaDraft?.(
            item.id,
            (event.currentTarget as HTMLTextAreaElement).value,
          ),
        onkeydown: (event: KeyboardEvent) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            controller.saveFormulaEdit?.(item.id);
          } else if (event.key === 'Escape') {
            controller.setFormulaDraft?.(item.id, item.currentTex);
          }
        },
      }),
    ]),
    !validation.valid
      ? m(
          `p#formula-error-${item.id}.formula-validation-error[role="alert"]`,
          validation.error,
        )
      : null,
    m('.formula-review-actions', [
      m(
        'button',
        {
          type: 'button',
          disabled: busy || !validation.valid,
          onclick: () => controller.saveFormulaEdit?.(item.id),
        },
        'Save edit',
      ),
      m(
        'button',
        {
          type: 'button',
          disabled: busy,
          onclick: () => controller.resetFormulaEdit?.(item.id),
        },
        'Reset detected value',
      ),
      m(
        'button',
        {
          type: 'button',
          disabled: busy,
          onclick: () => controller.rejectFormula?.(item.id),
        },
        'Not a formula',
      ),
      m(
        'button',
        {
          type: 'button',
          disabled: busy,
          onclick: () => controller.acceptFormula?.(item.id),
        },
        'Accept result',
      ),
    ]),
    m('.formula-review-navigation', [
      m(
        'button',
        { type: 'button', disabled: busy, onclick: () => move(-1) },
        'Previous formula',
      ),
      m(
        'button',
        { type: 'button', disabled: busy, onclick: () => move(1) },
        'Next formula',
      ),
    ]),
  ]);
}

function sourceRegion(
  controller: FormulaReviewController,
  item: FormulaReviewItem,
  compact: boolean,
): m.Vnode {
  const { state } = controller;
  const preview = state.pdfPreview;
  const bounds = item.candidate.bounds;
  if (!preview || preview.pageNumber !== item.candidate.page) {
    if (compact)
      return m(
        'span.formula-source-placeholder',
        `Page ${item.candidate.page} region`,
      );
    return m(
      'button.formula-source-load',
      {
        type: 'button',
        onclick: () => controller.selectFormula?.(item.id),
      },
      `Load page ${item.candidate.page} source region`,
    );
  }
  return m(
    '.formula-source-crop',
    {
      class: compact ? 'formula-source-crop--compact' : '',
      style: {
        aspectRatio: `${bounds.width * preview.width} / ${bounds.height * preview.height}`,
      },
    },
    m('img', {
      src: preview.url,
      alt: `Original PDF formula region on page ${item.candidate.page}`,
      style: {
        width: `${100 / bounds.width}%`,
        left: '0',
        top: '0',
        transform: `translate(${-bounds.x * 100}%, ${-bounds.top * 100}%)`,
      },
    }),
  );
}

function safeFormulaPreview(tex: string, display: boolean): m.Vnode {
  const result = validateFormulaDraft(tex, display);
  return result.valid
    ? m('.formula-safe-preview', m.trust(sanitizeFormulaHtml(result.html)))
    : m('span.formula-validation-error', result.error);
}

function sanitizeFormulaHtml(html: string): string {
  const purifier = DOMPurify as unknown as {
    sanitize?: (
      source: string,
      config: ReturnType<typeof previewSanitizeConfig>,
    ) => string;
  };
  if (purifier.sanitize)
    return purifier.sanitize(html, previewSanitizeConfig());
  if (typeof document === 'undefined') return html;
  throw new Error('Formula preview sanitizer is unavailable.');
}

function isBulkEligible(item: FormulaReviewItem): boolean {
  const confidence =
    item.candidate.recognition?.reviewConfidence ?? item.candidate.confidence;
  return (
    confidence === 'high' &&
    item.equation !== undefined &&
    item.status !== 'accepted' &&
    item.status !== 'rejected'
  );
}

function recognitionWarning(candidate: PdfFormulaCandidate): m.Vnode | null {
  if (!candidate.recognitionFailure) return null;
  return m(
    'span.formula-card-warning',
    `Recognition ${candidate.recognitionFailure}`,
  );
}

function methodLabel(
  method: NonNullable<Equation['recognition']>['method'] | undefined,
): string {
  if (method === 'pdf-onnx') return 'ONNX recognition';
  if (method === 'pdf-text') return 'PDF text reconstruction';
  if (method === 'pdf-geometry') return 'PDF geometry reconstruction';
  if (method === 'user') return 'User edit';
  return 'Recognition unavailable';
}

function statusLabel(status: FormulaReviewStatus): string {
  if (status === 'needs-review') return 'Unreviewed';
  return `${status[0]!.toUpperCase()}${status.slice(1)}`;
}

export function formulaReviewItems(
  candidates: readonly PdfFormulaCandidate[],
  equations: Readonly<Record<string, Equation>>,
  decisions: Readonly<Record<string, PdfFormulaDecision>>,
  filter: FormulaReviewFilter,
): FormulaReviewItem[] {
  return candidates
    .map((candidate) => {
      const equation = equations[candidate.id];
      const decision = decisions[candidate.id];
      const detectedTex =
        candidate.tex ?? candidate.recognition?.tex ?? equation?.tex ?? '';
      const status = formulaReviewStatus(equation, decision);
      return {
        id: candidate.id,
        candidate,
        ...(equation ? { equation } : {}),
        ...(decision ? { decision } : {}),
        detectedTex,
        currentTex: decision?.tex ?? equation?.tex ?? detectedTex,
        status,
      };
    })
    .filter((item) => filter === 'all' || item.status === filter);
}

export function moveFormulaSelection(
  ids: readonly string[],
  selectedId: string | undefined,
  offset: -1 | 1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const current = selectedId ? ids.indexOf(selectedId) : -1;
  const index = current < 0 ? 0 : (current + offset + ids.length) % ids.length;
  return ids[index];
}

export function validateFormulaDraft(
  tex: string,
  display = false,
): { valid: true; html: string } | { valid: false; error: string } {
  const value = tex.trim();
  if (!value) return { valid: false, error: 'LaTeX is required.' };
  if (!isValidTex(value))
    return { valid: false, error: 'Enter valid LaTeX before saving.' };
  return { valid: true, html: renderTex(value, display) };
}

function formulaReviewStatus(
  equation: Equation | undefined,
  decision: PdfFormulaDecision | undefined,
): FormulaReviewStatus {
  if (decision?.decision === 'text') return 'rejected';
  if (decision?.accepted || equation?.review?.status === 'accepted')
    return 'accepted';
  if (decision?.tex !== undefined) return 'edited';
  return 'needs-review';
}
