import m from 'mithril';
import DOMPurify from 'dompurify';
import type { Equation } from '@wordconvert/document-model';
import { isValidTex, renderTex } from '@wordconvert/math-converter';
import type {
  PdfFormulaCandidate,
  PdfFormulaDecision,
  PdfFormulaImageRegion,
} from '@wordconvert/pdf-reader';
import type { FormulaReviewFilter } from './state.ts';
import { formulaPreviewSanitizeConfig } from './preview/index.ts';
import {
  formulaSelectionEditor,
  type FormulaSelectionController,
} from './formula-selection.ts';

export type FormulaReviewStatus =
  'needs-review' | 'edited' | 'accepted' | 'rejected';

export interface FormulaReviewItem {
  id: string;
  kind: 'formula' | 'image';
  candidate?: PdfFormulaCandidate;
  image?: PdfFormulaImageRegion;
  equation?: Equation;
  decision?: PdfFormulaDecision;
  detectedTex: string;
  currentTex: string;
  status: FormulaReviewStatus;
}

export interface FormulaReviewController extends FormulaSelectionController {
  setFormulaReviewFilter?(filter: FormulaReviewFilter): void;
  selectFormula?(equationId: string): void;
  setFormulaDraft?(equationId: string, tex: string): void;
  saveFormulaEdit?(equationId: string): void;
  resetFormulaEdit?(equationId: string): void;
  rejectFormula?(equationId: string): void;
  acceptFormula?(equationId: string): void;
  acceptHighConfidenceFormulas?(): void;
  processFormulaImage?(imageId: string): void;
  saveFormulaImage?(imageId: string, tex: string): void;
  adjustFormulaImageRegion?(imageId: string): void;
  keepFormulaImage?(imageId: string): void;
  removeManualFormulaRegion?(equationId: string): void;
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
  const images = state.pdfAnalysis?.formulaImageRegions ?? [];
  const allItems = formulaReviewItems(
    candidates,
    state.model?.equations ?? {},
    state.pdfImport.formulaDecisions,
    'all',
    state.formulaDrafts,
    images,
  );
  const items = formulaReviewItems(
    candidates,
    state.model?.equations ?? {},
    state.pdfImport.formulaDecisions,
    state.formulaReviewFilter,
    state.formulaDrafts,
    images,
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
    formulaSelectionEditor(controller),
    state.formulaExtractionMessage
      ? m(
          'p.formula-extraction-status[role="status"][aria-live="polite"]',
          state.formulaExtractionMessage,
        )
      : null,
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
      'button.formula-review-done',
      {
        type: 'button',
        onclick: () => {
          if (typeof history !== 'undefined') history.back();
          else delete state.review;
        },
      },
      'Review Done, return',
    ),
  ]);
}

function formulaReviewCard(
  controller: FormulaReviewController,
  item: FormulaReviewItem,
  selected: FormulaReviewItem | undefined,
): m.Vnode {
  if (item.kind === 'image')
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
          m('span', 'Detected image'),
          m('span', 'Image'),
          m('strong', statusLabel(item.status)),
        ],
      ),
    );
  const candidate = item.candidate!;
  const confidence =
    candidate.recognition?.reviewConfidence ?? candidate.confidence;
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
        m('span', `${confidence} confidence`),
        m('span', methodLabel(item.equation?.recognition?.method)),
        m(
          'span',
          candidate.kind === 'display' ? 'Block formula' : 'Inline formula',
        ),
        m('strong', statusLabel(item.status)),
        recognitionWarning(candidate, item.currentTex),
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
  if (item.kind === 'image') {
    const draft = state.formulaDrafts[item.id] ?? '';
    const manual = validateFormulaDraft(draft, true);
    const previous = [
      ...new Set(
        Object.entries(state.model?.equations ?? {})
          .filter(([id]) => id !== item.id)
          .map(([, equation]) => equation.tex),
      ),
    ];
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
      m('label.formula-image-tex', [
        m('span', 'Enter LaTeX or reuse a previous formula'),
        previous.length
          ? m(
              'select',
              {
                'aria-label': 'Use previous formula',
                value: '',
                onchange: (event: Event) => {
                  const tex = (event.currentTarget as HTMLSelectElement).value;
                  if (tex) controller.setFormulaDraft?.(item.id, tex);
                },
              },
              [
                m(
                  'option',
                  { key: '__choose__', value: '' },
                  'Use previous formula...',
                ),
                ...previous.map((tex) =>
                  m('option', { key: tex, value: tex }, tex),
                ),
              ],
            )
          : null,
        m('input', {
          type: 'text',
          value: draft,
          placeholder: String.raw`\sqrt{d_{k}}`,
          oninput: (event: Event) =>
            controller.setFormulaDraft?.(
              item.id,
              (event.currentTarget as HTMLInputElement).value,
            ),
        }),
      ]),
      m('.formula-review-actions', [
        m(
          'button',
          {
            type: 'button',
            disabled: busy || !manual.valid,
            onclick: () => controller.saveFormulaImage?.(item.id, draft),
          },
          'Use typed formula',
        ),
        m(
          'button',
          {
            type: 'button',
            disabled: busy,
            onclick: () => controller.processFormulaImage?.(item.id),
          },
          busy && state.formulaExtractionId === item.id
            ? 'Extracting image...'
            : 'Extract images',
        ),
        m(
          'button',
          {
            type: 'button',
            disabled: busy,
            onclick: () => controller.adjustFormulaImageRegion?.(item.id),
          },
          'Adjust region',
        ),
        m(
          'button',
          {
            type: 'button',
            disabled: busy,
            onclick: () => controller.keepFormulaImage?.(item.id),
          },
          'Keep the image',
        ),
      ]),
      formulaReviewNavigation(busy, move),
    ]);
  }
  const candidate = item.candidate!;
  const draft = state.formulaDrafts[item.id] ?? item.currentTex;
  const validation = validateFormulaDraft(draft, candidate.kind === 'display');
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
    m('section.formula-render-section', [
      m('h4', 'Rendered formula'),
      m(
        '.formula-render-panel',
        validation.valid
          ? m.trust(sanitizeFormulaHtml(validation.html))
          : m('p.formula-validation-error[role="alert"]', validation.error),
      ),
    ]),
    m('label.formula-tex-field', [
      m('span', 'LaTeX'),
      m('textarea', {
        value: draft,
        rows: 8,
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
      candidate.sourceImageId
        ? m(
            'button',
            {
              type: 'button',
              disabled: busy,
              onclick: () =>
                controller.keepFormulaImage?.(candidate.sourceImageId!),
            },
            'Keep the image',
          )
        : null,
      candidate.sources.includes('manual')
        ? m(
            'button',
            {
              type: 'button',
              disabled: busy,
              onclick: () => controller.removeManualFormulaRegion?.(item.id),
            },
            'Remove manual region',
          )
        : null,
    ]),
    formulaReviewNavigation(busy, move),
  ]);
}

function formulaReviewNavigation(
  busy: boolean,
  move: (offset: -1 | 1) => void,
): m.Vnode {
  return m('.formula-review-navigation', [
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
  ]);
}

function sourceRegion(
  controller: FormulaReviewController,
  item: FormulaReviewItem,
  compact: boolean,
): m.Vnode {
  const { state } = controller;
  const preview = state.pdfPreview;
  const region = item.candidate ?? item.image!;
  const bounds = region.bounds;
  if (compact)
    return m('span.formula-source-placeholder', `Page ${region.page} region`);
  if (!preview || preview.pageNumber !== region.page) {
    return m(
      'button.formula-source-load',
      {
        type: 'button',
        onclick: () => controller.selectFormula?.(item.id),
      },
      `Load page ${region.page} source region`,
    );
  }
  return m(
    '.formula-source-crop',
    {
      class: '',
      style: {
        aspectRatio: `${bounds.width * preview.width} / ${bounds.height * preview.height}`,
        maxWidth: `${Math.max(1, preview.width * bounds.width * 2.9)}px`,
      },
    },
    m('img', {
      src: preview.url,
      alt: `Original PDF ${item.kind} region on page ${region.page}`,
      style: {
        width: `${100 / bounds.width}%`,
        left: '0',
        top: '0',
        transform: `translate(${-bounds.x * 100}%, ${-bounds.top * 100}%)`,
      },
    }),
  );
}

function sanitizeFormulaHtml(html: string): string {
  const purifier = DOMPurify as unknown as {
    sanitize?: (
      source: string,
      config: ReturnType<typeof formulaPreviewSanitizeConfig>,
    ) => string;
  };
  if (purifier.sanitize)
    return purifier.sanitize(html, formulaPreviewSanitizeConfig());
  if (typeof document === 'undefined') return html;
  throw new Error('Formula preview sanitizer is unavailable.');
}

function isBulkEligible(item: FormulaReviewItem): boolean {
  if (!item.candidate) return false;
  const confidence =
    item.candidate.recognition?.reviewConfidence ?? item.candidate.confidence;
  return (
    confidence === 'high' &&
    item.equation !== undefined &&
    item.status !== 'accepted' &&
    item.status !== 'rejected'
  );
}

function recognitionWarning(
  candidate: PdfFormulaCandidate,
  currentTex: string,
): m.Vnode | null {
  if (
    !candidate.recognitionFailure ||
    (currentTex.trim() !== '' &&
      isValidTex(normalizeFormulaTex(currentTex), candidate.kind === 'display'))
  )
    return null;
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
  drafts: Readonly<Record<string, string>> = {},
  images: readonly PdfFormulaImageRegion[] = [],
): FormulaReviewItem[] {
  const imageIds = new Set(images.map(({ id }) => id));
  const formulaItems: FormulaReviewItem[] = candidates
    .filter(({ id }) => !imageIds.has(id))
    .map((candidate) => {
      const equation = equations[candidate.id];
      const decision = decisions[candidate.id];
      const detectedTex =
        (candidate.requiresRecognition
          ? candidate.recognition?.tex
          : undefined) ??
        candidate.tex ??
        candidate.recognition?.tex ??
        equation?.tex ??
        '';
      const persistedTex = decision?.tex ?? equation?.tex ?? detectedTex;
      const draft = drafts[candidate.id];
      const status = formulaReviewStatus(
        equation,
        decision,
        draft,
        persistedTex,
      );
      return {
        id: candidate.id,
        kind: 'formula',
        candidate,
        ...(equation ? { equation } : {}),
        ...(decision ? { decision } : {}),
        detectedTex,
        currentTex: draft ?? persistedTex,
        status,
      };
    });
  const imageItems: FormulaReviewItem[] = images.map((image) => {
    const decision = decisions[image.id];
    const adjusted = candidates.find(
      ({ id, sourceImageId }) => id === image.id || sourceImageId === image.id,
    );
    return {
      id: image.id,
      kind: 'image',
      image: adjusted ? { ...image, bounds: adjusted.bounds } : image,
      ...(decision ? { decision } : {}),
      detectedTex: '',
      currentTex: '',
      status: decision?.decision === 'image' ? 'accepted' : 'needs-review',
    };
  });
  return [...formulaItems, ...imageItems]
    .sort(
      (left, right) =>
        (left.candidate ?? left.image!).page -
          (right.candidate ?? right.image!).page ||
        (left.candidate ?? left.image!).bounds.top -
          (right.candidate ?? right.image!).bounds.top,
    )
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
):
  { valid: true; tex: string; html: string } | { valid: false; error: string } {
  const value = normalizeFormulaTex(tex);
  if (!value) return { valid: false, error: 'LaTeX is required.' };
  if (!isValidTex(value, display))
    return { valid: false, error: 'Enter valid LaTeX before saving.' };
  return { valid: true, tex: value, html: renderTex(value, display) };
}

export function normalizeFormulaTex(tex: string): string {
  const lines = tex
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? '';
  return `\\begin{aligned}${lines.join(' \\\\ ')}\\end{aligned}`;
}

function formulaReviewStatus(
  equation: Equation | undefined,
  decision: PdfFormulaDecision | undefined,
  draft: string | undefined,
  persistedTex: string,
): FormulaReviewStatus {
  if (decision?.decision === 'text') return 'rejected';
  if (decision?.accepted || equation?.review?.status === 'accepted')
    return 'accepted';
  if (draft !== undefined && draft !== persistedTex) return 'edited';
  if (decision?.tex !== undefined) return 'edited';
  return 'needs-review';
}
