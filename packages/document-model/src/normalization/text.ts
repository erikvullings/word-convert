import type {
  BlockNode,
  ConversionWarning,
  DocumentModel,
  InlineNode,
  ParagraphNode,
  SceneBreakMarker,
  TextNormalizationOptions,
  TextNormalizationSummary,
} from '../index.ts';

export const MAX_TEXT_NORMALIZATION_TEXT = 5_000_000;
export const MAX_TEXT_NORMALIZATION_NODES = 500_000;

export const DEFAULT_TEXT_NORMALIZATION_OPTIONS: Readonly<
  Required<Omit<TextNormalizationOptions, 'sceneBreakMarker' | 'language'>>
> = {
  sceneBreaks: true,
  blankParagraphs: true,
  ligatures: true,
  smartenPunctuation: false,
  unsmartenPunctuation: false,
};

// Keep this curated set aligned with the ornament cases in text.test.ts.
const SCENE_BREAK_ORNAMENTS = [
  /^\*{3}$/u,
  /^\*\s+\*\s+\*$/u,
  /^[·•]\s+[·•]\s+[·•]$/u,
  /^⁂$/u,
  /^—\s+—\s+—$/u,
  /^-\s+-\s+-$/u,
  /^_{3,10}$/u,
];

const SCENE_BREAK_MARKERS: Record<SceneBreakMarker, string> = {
  asterisks: '* * *',
  dots: '· · ·',
  floral: '⁂',
  'em-dash': '—',
};

const LIGATURES: Readonly<Record<string, string>> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
  '\u0132': 'IJ',
  '\u0133': 'ij',
};

const URL = /(?:https?:\/\/|www\.)[^\s]+/giu;

// These context pairs are pinned by the numeric-range and spaced-dash fixtures.
const DASH_CONTEXTS = [
  { before: /\d/u, after: /\d/u, replacement: '–' },
  { before: /\s/u, after: /\s/u, replacement: '—' },
] as const;

// Locale quote pairs are exercised by the nested English and French fixtures.
const QUOTE_STYLES: Record<
  string,
  { double: readonly [string, string]; single: readonly [string, string] }
> = {
  de: { double: ['„', '“'], single: ['‚', '‘'] },
  es: { double: ['«', '»'], single: ['“', '”'] },
  fr: { double: ['«\u202f', '\u202f»'], single: ['‹', '›'] },
};

interface WorkBudget {
  nodes: number;
  text: number;
  exceeded: boolean;
}

function blankSummary(): TextNormalizationSummary {
  return {
    sceneBreaks: 0,
    blankParagraphsRemoved: 0,
    ligatures: 0,
    punctuationSmartened: 0,
    punctuationUnsmartened: 0,
    budgetExceeded: false,
  };
}

function resolveOptions(options?: TextNormalizationOptions) {
  const resolved = { ...DEFAULT_TEXT_NORMALIZATION_OPTIONS, ...options };
  if (resolved.smartenPunctuation && resolved.unsmartenPunctuation)
    throw new TypeError(
      'Punctuation cannot be smartened and unsmartened in the same pass.',
    );
  if (
    options?.sceneBreakMarker !== undefined &&
    !Object.hasOwn(SCENE_BREAK_MARKERS, options.sceneBreakMarker)
  )
    throw new TypeError('Unsupported scene-break marker.');
  if (options?.sceneBreakMarker !== undefined && !resolved.sceneBreaks)
    throw new TypeError('Scene-break markers require scene-break detection.');
  return resolved;
}

export function isSceneBreakOrnament(text: string): boolean {
  const candidate = text.trim();
  const punctuationCount = [...candidate].filter(
    (character) => !/\s/u.test(character),
  ).length;
  if (
    punctuationCount < 1 ||
    punctuationCount > 10 ||
    /[\p{L}\p{N}]/u.test(candidate) ||
    /^[\p{Ll}]/u.test(candidate) ||
    /[.!?;:,]$/u.test(candidate)
  )
    return false;
  return SCENE_BREAK_ORNAMENTS.some((pattern) => pattern.test(candidate));
}

function emptyParagraph(block: BlockNode): block is ParagraphNode {
  let length = 0;
  return (
    block.type === 'paragraph' &&
    block.children.every((node) => {
      if (
        node.type !== 'text' ||
        node.marks?.some((mark) => mark.type === 'code')
      )
        return false;
      length += node.text.length;
      return length <= 1024 && node.text.trim() === '';
    })
  );
}

export function createSceneBreakBlock(
  options?: TextNormalizationOptions,
): BlockNode {
  const marker = options?.sceneBreakMarker
    ? SCENE_BREAK_MARKERS[options.sceneBreakMarker]
    : undefined;
  return marker
    ? { type: 'paragraph', children: [{ type: 'text', text: marker }] }
    : { type: 'thematicBreak' };
}

function visit(budget: WorkBudget): boolean {
  if (budget.exceeded) return false;
  if (++budget.nodes > MAX_TEXT_NORMALIZATION_NODES) {
    budget.exceeded = true;
    return false;
  }
  return true;
}

function inspectBlankParagraphs(
  blocks: readonly BlockNode[],
  budget: WorkBudget,
  totals: { paragraphs: number; blanks: number; alternating: number },
  depth = 0,
): void {
  if (budget.exceeded || depth > 128) {
    budget.exceeded = true;
    return;
  }
  let previousContent = false;
  let pendingBlank: ParagraphNode | undefined;
  for (const block of blocks) {
    if (!visit(budget)) return;
    const blank = emptyParagraph(block);
    if (block.type === 'paragraph') {
      totals.paragraphs++;
      if (blank) {
        totals.blanks++;
        if (previousContent && pendingBlank === undefined) pendingBlank = block;
        else pendingBlank = undefined;
      } else {
        if (pendingBlank) totals.alternating++;
        previousContent = true;
        pendingBlank = undefined;
      }
    } else {
      previousContent = false;
      pendingBlank = undefined;
    }
    if (block.type === 'list') {
      for (const item of block.items)
        inspectBlankParagraphs(item.blocks, budget, totals, depth + 1);
    } else if (block.type === 'table') {
      for (const row of block.rows)
        for (const cell of row.cells)
          inspectBlankParagraphs(cell.blocks, budget, totals, depth + 1);
    } else if (block.type === 'blockquote')
      inspectBlankParagraphs(block.blocks, budget, totals, depth + 1);
  }
}

function isContentParagraph(block: BlockNode | undefined): boolean {
  return (
    block?.type === 'paragraph' &&
    block.children.some(
      (node) =>
        node.type !== 'text' ||
        node.text.trim().length > 0 ||
        node.marks?.some(({ type }) => type === 'code') === true,
    )
  );
}

async function normalizeBlockList(
  blocks: BlockNode[],
  options: ReturnType<typeof resolveOptions>,
  summary: TextNormalizationSummary,
  budget: WorkBudget,
  deleteIsolatedBlanks: boolean,
  checkpoint: () => Promise<void>,
  depth = 0,
): Promise<void> {
  if (budget.exceeded || depth > 128) {
    budget.exceeded = true;
    return;
  }
  let processed = 0;
  for (let index = 0; index < blocks.length;) {
    if (!visit(budget)) break;
    if (processed++ % 256 === 0) await checkpoint();
    const block = blocks[index];
    if (!block) break;
    if (
      options.sceneBreaks &&
      options.sceneBreakMarker &&
      block.type === 'thematicBreak'
    ) {
      blocks.splice(index, 1, createSceneBreakBlock(options));
      summary.sceneBreaks++;
      index++;
      continue;
    }
    if (
      (options.blankParagraphs || options.sceneBreaks) &&
      emptyParagraph(block)
    ) {
      let end = index + 1;
      while (end < blocks.length && emptyParagraph(blocks[end]!)) {
        if (!visit(budget)) break;
        end++;
      }
      if (budget.exceeded) break;
      const count = end - index;
      if (
        options.sceneBreaks &&
        count >= 2 &&
        isContentParagraph(blocks[index - 1]) &&
        isContentParagraph(blocks[end])
      ) {
        blocks.splice(index, count, createSceneBreakBlock(options));
        summary.sceneBreaks++;
        summary.blankParagraphsRemoved += count;
        index++;
      } else if (options.blankParagraphs && deleteIsolatedBlanks) {
        blocks.splice(index, count);
        summary.blankParagraphsRemoved += count;
      } else index = end;
      continue;
    }
    if (block.type === 'list') {
      for (const item of block.items)
        await normalizeBlockList(
          item.blocks,
          options,
          summary,
          budget,
          deleteIsolatedBlanks,
          checkpoint,
          depth + 1,
        );
    } else if (block.type === 'table') {
      for (const row of block.rows)
        for (const cell of row.cells)
          await normalizeBlockList(
            cell.blocks,
            options,
            summary,
            budget,
            deleteIsolatedBlanks,
            checkpoint,
            depth + 1,
          );
      if (block.caption)
        normalizeInlineNodes(block.caption, options, summary, budget);
    } else if (block.type === 'blockquote')
      await normalizeBlockList(
        block.blocks,
        options,
        summary,
        budget,
        deleteIsolatedBlanks,
        checkpoint,
        depth + 1,
      );
    else if (block.type === 'paragraph' || block.type === 'heading')
      normalizeInlineNodes(block.children, options, summary, budget);
    else if (block.type === 'imageBlock' && block.caption)
      normalizeInlineNodes(block.caption, options, summary, budget);
    index++;
  }
}

function normalizeInlineNodes(
  nodes: InlineNode[],
  options: ReturnType<typeof resolveOptions>,
  summary: TextNormalizationSummary,
  budget: WorkBudget,
  depth = 0,
): void {
  if (budget.exceeded || depth > 128) {
    budget.exceeded = true;
    return;
  }
  for (const node of nodes) {
    if (!visit(budget)) return;
    if (node.type === 'link') {
      normalizeInlineNodes(node.children, options, summary, budget, depth + 1);
      continue;
    }
    if (node.type !== 'text' || node.marks?.some(({ type }) => type === 'code'))
      continue;
    if (budget.text + node.text.length > MAX_TEXT_NORMALIZATION_TEXT) {
      budget.exceeded = true;
      return;
    }
    budget.text += node.text.length;
    let text = node.text;
    if (options.ligatures) {
      text = text.replace(/[\ufb00-\ufb06\u0132\u0133]/gu, (glyph) => {
        const replacement = LIGATURES[glyph] ?? glyph;
        if (replacement !== glyph) summary.ligatures++;
        return replacement;
      });
    }
    if (options.smartenPunctuation) {
      const result = smarten(text, options.language, summary);
      text = result;
    } else if (options.unsmartenPunctuation) {
      text = unsmarten(text, summary);
    }
    node.text = text;
  }
}

function smarten(
  text: string,
  language: string | undefined,
  summary: TextNormalizationSummary,
): string {
  const style = QUOTE_STYLES[language?.split('-')[0]?.toLowerCase() ?? ''] ?? {
    double: ['“', '”'] as const,
    single: ['‘', '’'] as const,
  };
  const urls = [...text.matchAll(URL)].map(
    (match) => [match.index!, match.index! + match[0].length] as const,
  );
  let urlIndex = 0;
  const stack: Array<'"' | "'"> = [];
  let output = '';
  for (let index = 0; index < text.length;) {
    while (urlIndex < urls.length && urls[urlIndex]![1] <= index) urlIndex++;
    const url = urls[urlIndex];
    if (url && index === url[0]) {
      output += text.slice(url[0], url[1]);
      index = url[1];
      continue;
    }
    if (text.startsWith('...', index) && !text.startsWith('....', index)) {
      output += '…';
      summary.punctuationSmartened++;
      index += 3;
      continue;
    }
    if (text.startsWith('--', index)) {
      const previous = text[index - 1] ?? '';
      const next = text[index + 2] ?? '';
      const context = DASH_CONTEXTS.find(
        ({ before, after }) => before.test(previous) && after.test(next),
      );
      if (context) {
        output += context.replacement;
        summary.punctuationSmartened++;
        index += 2;
        continue;
      }
    }
    const quote = text[index] as '"' | "'" | undefined;
    if (quote === '"' || quote === "'") {
      const previous = text[index - 1] ?? '';
      const next = text[index + 1] ?? '';
      if (
        /\d/u.test(previous) ||
        /\d/u.test(next) ||
        (quote === "'" && /\p{L}/u.test(previous) && /\p{L}/u.test(next))
      ) {
        if (quote === "'" && /\p{L}/u.test(previous) && /\p{L}/u.test(next)) {
          output += '’';
          summary.punctuationSmartened++;
        } else output += quote;
        index++;
        continue;
      }
      const closes =
        stack.at(-1) === quote &&
        /[\p{L}\p{N}.,!?;:)\]}”’]/u.test(previous) &&
        (next === '' || /[\s.,!?;:)\]}]/u.test(next));
      const opens =
        (previous === '' || /[\s([{=,:;!?]/u.test(previous)) &&
        /[\p{L}\p{N}([{“‘]/u.test(next);
      if (closes !== opens) {
        const pair = quote === '"' ? style.double : style.single;
        output += closes ? pair[1] : pair[0];
        if (closes) stack.pop();
        else stack.push(quote);
        summary.punctuationSmartened++;
      } else output += quote;
      index++;
      continue;
    }
    output += text[index]!;
    index++;
  }
  return output;
}

function unsmarten(text: string, summary: TextNormalizationSummary): string {
  const urls = [...text.matchAll(URL)].map(
    (match) => [match.index!, match.index! + match[0].length] as const,
  );
  let urlIndex = 0;
  let output = '';
  for (let index = 0; index < text.length;) {
    while (urlIndex < urls.length && urls[urlIndex]![1] <= index) urlIndex++;
    const url = urls[urlIndex];
    if (url && index === url[0]) {
      output += text.slice(url[0], url[1]);
      index = url[1];
      continue;
    }
    const character = text[index]!;
    const replacement =
      character === '…'
        ? '...'
        : character === '—' || character === '–'
          ? '--'
          : /[“”„‟«»‹›]/u.test(character)
            ? '"'
            : /[‘’‚‛]/u.test(character)
              ? "'"
              : character;
    if (replacement !== character) summary.punctuationUnsmartened++;
    output += replacement;
    index++;
  }
  return output;
}

async function normalizeBlocksWithBudget(
  blocks: BlockNode[],
  resolved: ReturnType<typeof resolveOptions>,
  summary: TextNormalizationSummary,
  budget: WorkBudget,
  checkpoint: () => Promise<void>,
): Promise<void> {
  if (resolved.blankParagraphs) {
    const totals = { paragraphs: 0, blanks: 0, alternating: 0 };
    inspectBlankParagraphs(blocks, budget, totals);
    const blankRatio = totals.blanks / Math.max(1, totals.paragraphs);
    const deleteIsolatedBlanks =
      blankRatio > 0.4 ||
      (totals.blanks >= 3 && totals.alternating / totals.blanks >= 0.8);
    if (!budget.exceeded)
      await normalizeBlockList(
        blocks,
        resolved,
        summary,
        budget,
        deleteIsolatedBlanks,
        checkpoint,
      );
  } else if (!budget.exceeded) {
    await normalizeBlockList(
      blocks,
      resolved,
      summary,
      budget,
      false,
      checkpoint,
    );
  }
  summary.budgetExceeded ||= budget.exceeded;
}

export async function normalizeDocumentBlocks(
  blocks: BlockNode[],
  options?: TextNormalizationOptions,
  language?: string,
  checkpoint: () => Promise<void> = async () => {},
  initialSummary?: Partial<TextNormalizationSummary>,
): Promise<TextNormalizationSummary> {
  const resolved = resolveOptions({
    ...options,
    ...(language && !options?.language ? { language } : {}),
  });
  const summary = { ...blankSummary(), ...initialSummary };
  const budget: WorkBudget = { nodes: 0, text: 0, exceeded: false };
  await normalizeBlocksWithBudget(
    blocks,
    resolved,
    summary,
    budget,
    checkpoint,
  );
  return summary;
}

export async function normalizeDocumentText(
  model: DocumentModel,
  options?: TextNormalizationOptions,
  checkpoint?: () => Promise<void>,
): Promise<TextNormalizationSummary> {
  const language = options?.language ?? model.metadata.language?.value;
  const resolved = resolveOptions({
    ...options,
    ...(language && !options?.language ? { language } : {}),
  });
  const summary = blankSummary();
  const budget: WorkBudget = { nodes: 0, text: 0, exceeded: false };
  const verifyCancellation = checkpoint ?? (async () => {});
  await normalizeBlocksWithBudget(
    model.blocks,
    resolved,
    summary,
    budget,
    verifyCancellation,
  );
  let processed = 0;
  for (const note of Object.values(model.notes)) {
    if (budget.exceeded) break;
    if (processed++ % 256 === 0) await verifyCancellation();
    await normalizeBlocksWithBudget(
      note.blocks,
      resolved,
      summary,
      budget,
      verifyCancellation,
    );
  }
  if (!model.warnings.some(({ code }) => code === 'text-normalization-summary'))
    model.warnings.push(createTextNormalizationWarning(summary));
  return summary;
}

export function createTextNormalizationWarning(
  summary: TextNormalizationSummary,
): ConversionWarning {
  return {
    code: 'text-normalization-summary',
    severity: summary.budgetExceeded ? 'warning' : 'info',
    message: summary.budgetExceeded
      ? 'Text normalization reached its work limit; remaining text was preserved.'
      : 'Text normalization completed with the reported changes.',
    details: { ...summary },
  };
}
