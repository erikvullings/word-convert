import type { RawPdfTextSpan } from '../index.ts';
import { extractMathFeatures, PDF_FORMULA_THRESHOLDS } from './features.ts';
import { reconstructSimpleTex } from './reconstruct.ts';
import type {
  PdfBounds,
  PdfFormulaCandidate,
  PdfFormulaSource,
  PdfManualFormulaRegion,
} from './types.ts';

interface LayoutRegion extends PdfBounds {
  label: string;
  confidence: number;
}

export function createFormulaCandidates(input: {
  page: number;
  spans: readonly RawPdfTextSpan[];
  layoutRegions?: readonly LayoutRegion[];
  renderedEquationRegions?: readonly PdfBounds[];
  taggedFormulaSpanIds?: ReadonlySet<string>;
}): PdfFormulaCandidate[] {
  const typicalFontSize = median(
    input.spans
      .filter(({ text }) => text.trim())
      .map(({ fontSize }) => fontSize),
  );
  const groups = geometryGroups(input.spans).filter((spans) =>
    isFormulaGroup(spans, typicalFontSize, input.spans),
  );
  const proposals = groups.map((spans) =>
    candidate(input.page, spans, undefined, input.taggedFormulaSpanIds),
  );
  for (const region of input.renderedEquationRegions ?? []) {
    const rendered = renderedEquationCandidate(input.page, region, input.spans);
    const renderedText = candidateText(rendered, input.spans);
    const semanticCandidate = proposals.find(
      (proposal) =>
        shouldFuse(proposal.bounds, rendered.bounds) ||
        (!/[=<>≤≥]/u.test(renderedText) &&
          /[=<>≤≥]/u.test(candidateText(proposal, input.spans)) &&
          nearbyOnSameLine(proposal.bounds, rendered.bounds)),
    );
    if (semanticCandidate) mergeCandidate(semanticCandidate, rendered);
  }
  for (const region of input.layoutRegions ?? []) {
    if (
      region.label !== 'formula' ||
      region.confidence < PDF_FORMULA_THRESHOLDS.heronConfidence
    )
      continue;
    const spans = input.spans.filter((span) => intersects(span, region));
    if (spans.length > 0)
      proposals.push(
        candidate(input.page, spans, region, input.taggedFormulaSpanIds),
      );
  }
  const fused: PdfFormulaCandidate[] = [];
  for (const proposal of proposals.sort(comparePosition)) {
    const existing = fused.find(({ bounds }) =>
      shouldFuse(bounds, proposal.bounds),
    );
    if (!existing) fused.push(proposal);
    else mergeCandidate(existing, proposal);
  }
  return fused.sort(comparePosition).map((value, index) => ({
    ...value,
    id: `pdf-equation-p${input.page}-${String(index + 1).padStart(3, '0')}`,
  }));
}

export function padFormulaBounds(
  bounds: PdfBounds,
  padding = 0.008,
): PdfBounds {
  const x = Math.max(0, bounds.x - padding);
  const top = Math.max(0, bounds.top - padding);
  const right = Math.min(1, bounds.x + bounds.width + padding);
  const bottom = Math.min(1, bounds.top + bounds.height + padding);
  return { x, top, width: right - x, height: bottom - top };
}

export function createManualFormulaCandidate(
  region: PdfManualFormulaRegion,
  spans: readonly RawPdfTextSpan[],
): PdfFormulaCandidate {
  const formulaSpans = spans.filter((span) => intersects(span, region.bounds));
  const features = extractMathFeatures(formulaSpans, { isolated: true });
  const tex = reconstructSimpleTex(formulaSpans);
  return {
    id: region.id,
    page: region.page,
    kind: region.kind,
    bounds: region.bounds,
    spanIds: formulaSpans.map(({ id }) => id),
    features,
    score: features.score,
    confidence: 'medium',
    sources: ['manual'],
    ...(region.sourceImageId ? { sourceImageId: region.sourceImageId } : {}),
    ...(tex ? { tex } : {}),
    requiresRecognition:
      region.skipRecognition !== true &&
      (region.forceRecognition === true || tex === undefined),
  };
}

function geometryGroups(spans: readonly RawPdfTextSpan[]): RawPdfTextSpan[][] {
  const sorted = [...spans]
    .filter(({ text }) => text.trim())
    .sort((left, right) => left.top - right.top || left.x - right.x);
  const inlineRuns = sorted
    .filter(({ text }) => /[A-Za-z0-9Α-ω]\s*[=<>≤≥]\s*[^\s]/u.test(text))
    .map((span) => [span]);
  const groups: RawPdfTextSpan[][] = [];
  for (const span of sorted) {
    const group = groups.findLast((candidate) => {
      const bounds = boundsOf(candidate);
      return (
        Math.abs(span.top - bounds.top) <= 0.025 &&
        span.x - (bounds.x + bounds.width) <= 0.04
      );
    });
    if (group) group.push(span);
    else groups.push([span]);
  }
  return [...inlineRuns, ...groups];
}

function isFormulaGroup(
  spans: readonly RawPdfTextSpan[],
  typicalFontSize: number,
  pageSpans: readonly RawPdfTextSpan[],
): boolean {
  const text = spans.map(({ text }) => text).join(' ');
  const features = extractMathFeatures(spans, { isolated: true });
  const proseSpansPageWidth =
    boundsOf(spans).width > PDF_FORMULA_THRESHOLDS.maxProseGeometryWidth &&
    features.dictionaryLikeWordRatio >=
      PDF_FORMULA_THRESHOLDS.minWideGeometryDictionaryWordRatio;
  return (
    Math.max(...spans.map(({ fontSize }) => fontSize)) >=
      typicalFontSize * 0.85 &&
    !isSubordinateScript(spans, pageSpans) &&
    /[=<>≤≥]/u.test(text) &&
    !/^\s*[A-Za-z]{3,}(?:\s+[A-Za-z]{3,})+\s*$/u.test(text) &&
    !proseSpansPageWidth &&
    features.dictionaryLikeWordRatio <=
      PDF_FORMULA_THRESHOLDS.maxGeometryDictionaryWordRatio &&
    features.score >= PDF_FORMULA_THRESHOLDS.geometryScore
  );
}

function isSubordinateScript(
  spans: readonly RawPdfTextSpan[],
  pageSpans: readonly RawPdfTextSpan[],
): boolean {
  const bounds = boundsOf(spans);
  const maximumSize = Math.max(...spans.map(({ fontSize }) => fontSize));
  return pageSpans.some(
    (span) =>
      !spans.includes(span) &&
      span.fontSize >= maximumSize * 1.5 &&
      span.x < bounds.x + bounds.width &&
      span.x + span.width > bounds.x &&
      Math.max(
        0,
        bounds.top - (span.top + span.height),
        span.top - (bounds.top + bounds.height),
      ) <= 0.02,
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function candidate(
  page: number,
  spans: readonly RawPdfTextSpan[],
  heron?: LayoutRegion,
  taggedFormulaSpanIds?: ReadonlySet<string>,
): PdfFormulaCandidate {
  const formulaSpans = spans.filter(
    ({ text }) => !/^\(\d+[a-z]?\)$/i.test(text.trim()),
  );
  const features = extractMathFeatures(formulaSpans, {
    isolated: true,
    ...(heron ? { heronFormulaConfidence: heron.confidence } : {}),
  });
  const tex = reconstructSimpleTex(formulaSpans);
  const sources: PdfFormulaSource[] = [
    ...(heron ? (['heron'] as const) : []),
    'geometry',
    ...(features.mathFontRatio > 0 ? (['font'] as const) : []),
    ...(features.operatorRatio + features.greekRatio + features.symbolRatio > 0
      ? (['symbols'] as const)
      : []),
    ...(formulaSpans.some(({ id }) => taggedFormulaSpanIds?.has(id))
      ? (['tagged-structure'] as const)
      : []),
  ];
  return {
    id: '',
    page,
    kind: heron || features.centered ? 'display' : 'inline',
    bounds: padFormulaBounds(boundsOf(formulaSpans)),
    spanIds: formulaSpans.map(({ id }) => id),
    features,
    score: features.score,
    confidence: features.confidence,
    sources: [...new Set(sources)],
    ...(tex ? { tex } : {}),
    requiresRecognition: tex === undefined,
  };
}

function mergeCandidate(
  target: PdfFormulaCandidate,
  source: PdfFormulaCandidate,
): void {
  target.bounds = union(target.bounds, source.bounds);
  target.spanIds = [...new Set([...target.spanIds, ...source.spanIds])];
  target.sources = [...new Set([...target.sources, ...source.sources])];
  if (source.score > target.score) {
    target.features = source.features;
    target.score = source.score;
    target.confidence = source.confidence;
  }
  target.kind =
    target.kind === 'display' || source.kind === 'display'
      ? 'display'
      : target.kind;
  if (source.sources.includes('rasterized-equation')) {
    target.sources = [
      ...new Set<PdfFormulaSource>([...target.sources, 'rasterized-equation']),
    ];
    delete target.tex;
    target.requiresRecognition = true;
  }
}

function renderedEquationCandidate(
  page: number,
  bounds: PdfBounds,
  pageSpans: readonly RawPdfTextSpan[],
): PdfFormulaCandidate {
  const spans = pageSpans.filter((span) => intersects(span, bounds));
  const features = extractMathFeatures(spans, { isolated: true });
  return {
    id: '',
    page,
    kind: 'display',
    bounds: {
      x: bounds.x,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    },
    spanIds: spans.map(({ id }) => id),
    features,
    score: features.score,
    confidence: 'medium',
    sources: ['rasterized-equation'],
    requiresRecognition: true,
  };
}

function shouldFuse(left: PdfBounds, right: PdfBounds): boolean {
  return (
    coverage(left, right) >= PDF_FORMULA_THRESHOLDS.fusionCoverage ||
    coverage(right, left) >= PDF_FORMULA_THRESHOLDS.fusionCoverage
  );
}

function candidateText(
  candidate: PdfFormulaCandidate,
  pageSpans: readonly RawPdfTextSpan[],
): string {
  return pageSpans
    .filter(({ id }) => candidate.spanIds.includes(id))
    .map(({ text }) => text)
    .join(' ');
}

function nearbyOnSameLine(left: PdfBounds, right: PdfBounds): boolean {
  const verticalGap = Math.max(
    0,
    left.top - (right.top + right.height),
    right.top - (left.top + left.height),
  );
  const horizontalGap = Math.max(
    0,
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
  );
  return verticalGap <= 0.015 && horizontalGap <= 0.08;
}

function boundsOf(spans: readonly RawPdfTextSpan[]): PdfBounds {
  const x = Math.min(...spans.map((span) => span.x));
  const top = Math.min(...spans.map((span) => span.top));
  const right = Math.max(...spans.map((span) => span.x + span.width));
  const bottom = Math.max(...spans.map((span) => span.top + span.height));
  return { x, top, width: right - x, height: bottom - top };
}

function intersects(left: PdfBounds, right: PdfBounds): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}

function coverage(target: PdfBounds, covering: PdfBounds): number {
  const width = Math.max(
    0,
    Math.min(target.x + target.width, covering.x + covering.width) -
      Math.max(target.x, covering.x),
  );
  const height = Math.max(
    0,
    Math.min(target.top + target.height, covering.top + covering.height) -
      Math.max(target.top, covering.top),
  );
  return (
    (width * height) / Math.max(target.width * target.height, Number.EPSILON)
  );
}

function union(left: PdfBounds, right: PdfBounds): PdfBounds {
  const x = Math.min(left.x, right.x);
  const top = Math.min(left.top, right.top);
  return {
    x,
    top,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.top + left.height, right.top + right.height) - top,
  };
}

function comparePosition(
  left: PdfFormulaCandidate,
  right: PdfFormulaCandidate,
): number {
  return left.bounds.top - right.bounds.top || left.bounds.x - right.bounds.x;
}
