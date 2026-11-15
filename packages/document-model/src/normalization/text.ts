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
import {
  MAX_TEXT_PATTERN_CANDIDATE_LINES,
  MAX_TEXT_PATTERN_LINE_LENGTH,
  MAX_TEXT_PATTERN_MATCHES,
  MAX_TEXT_PATTERN_RULES,
  MAX_TEXT_PATTERN_WORK_MS,
  compileTextReplacementRule,
  type CompiledTextReplacementRule,
} from './pattern-rules.ts';

export const MAX_TEXT_NORMALIZATION_TEXT = 5_000_000;
export const MAX_TEXT_NORMALIZATION_NODES = 500_000;

export const DEFAULT_TEXT_NORMALIZATION_OPTIONS: Readonly<
  Required<
    Omit<
      TextNormalizationOptions,
      'sceneBreakMarker' | 'language' | 'textRules'
    >
  >
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
  patterns: CompiledTextReplacementRule[];
  patternStartedAt: number;
  patternCandidateLines: number;
  patternMatches: number;
  patternOutputCharacters: number;
  patternRulesRejected: number;
  patternRejectedRuleIds: string[];
  patternWorkLimitExceeded: boolean;
}

function blankSummary(): TextNormalizationSummary {
  return {
    sceneBreaks: 0,
    blankParagraphsRemoved: 0,
    ligatures: 0,
    punctuationSmartened: 0,
    punctuationUnsmartened: 0,
    patternMatches: 0,
    patternRulesRejected: 0,
    patternRejectedRuleIds: '',
    patternWorkLimitExceeded: false,
    emptyBlocksRemoved: 0,
    budgetExceeded: false,
  };
}

function createWorkBudget(
  options: ReturnType<typeof resolveOptions>,
  summary: TextNormalizationSummary,
): WorkBudget {
  const suppliedRules = options.textRules ?? [];
  const exceedsRuleLimit = suppliedRules.length > MAX_TEXT_PATTERN_RULES;
  const patterns = exceedsRuleLimit
    ? []
    : suppliedRules.map(compileTextReplacementRule);
  const rejected = patterns.filter(({ rejection }) => rejection);
  const rejectedRuleIds = exceedsRuleLimit
    ? [suppliedRules[MAX_TEXT_PATTERN_RULES]?.id ?? 'text-rule-limit']
    : rejected.map(({ id }) => id);
  summary.patternRulesRejected = exceedsRuleLimit
    ? suppliedRules.length
    : rejected.length;
  summary.patternRejectedRuleIds = rejectedRuleIds.join(',');
  return {
    nodes: 0,
    text: 0,
    exceeded: false,
    patterns,
    patternStartedAt: Date.now(),
    patternCandidateLines: 0,
    patternMatches: 0,
    patternOutputCharacters: 0,
    patternRulesRejected: summary.patternRulesRejected,
    patternRejectedRuleIds: rejectedRuleIds,
    patternWorkLimitExceeded: false,
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
): Promise<boolean> {
  if (budget.exceeded || depth > 128) {
    budget.exceeded = true;
    return false;
  }
  let removedByRule = false;
  let processed = 0;
  for (let index = 0; index < blocks.length;) {
    if (!visit(budget)) return removedByRule;
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
      for (let itemIndex = 0; itemIndex < block.items.length;) {
        const item = block.items[itemIndex]!;
        const emptiedByRule = await normalizeBlockList(
          item.blocks,
          options,
          summary,
          budget,
          deleteIsolatedBlanks,
          checkpoint,
          depth + 1,
        );
        if (emptiedByRule && item.blocks.length === 0) {
          block.items.splice(itemIndex, 1);
          summary.emptyBlocksRemoved++;
          removedByRule = true;
        } else itemIndex++;
      }
      if (removedByRule && block.items.length === 0) {
        blocks.splice(index, 1);
        summary.emptyBlocksRemoved++;
        continue;
      }
    } else if (block.type === 'table') {
      for (let rowIndex = 0; rowIndex < block.rows.length;) {
        const row = block.rows[rowIndex]!;
        let rowRemovedByRule = false;
        for (let cellIndex = 0; cellIndex < row.cells.length;) {
          const cell = row.cells[cellIndex]!;
          const hadBlocks = cell.blocks.length > 0;
          const emptiedByRule = await normalizeBlockList(
            cell.blocks,
            options,
            summary,
            budget,
            deleteIsolatedBlanks,
            checkpoint,
            depth + 1,
          );
          if (hadBlocks && emptiedByRule && cell.blocks.length === 0) {
            row.cells.splice(cellIndex, 1);
            summary.emptyBlocksRemoved++;
            removedByRule = true;
            rowRemovedByRule = true;
          } else cellIndex++;
        }
        if (rowRemovedByRule && row.cells.length === 0) {
          block.rows.splice(rowIndex, 1);
          summary.emptyBlocksRemoved++;
        } else rowIndex++;
      }
      if (block.caption)
        await normalizeInlineNodes(
          block.caption,
          options,
          summary,
          budget,
          checkpoint,
        );
      if (removedByRule && block.rows.length === 0) {
        blocks.splice(index, 1);
        summary.emptyBlocksRemoved++;
        continue;
      }
    } else if (block.type === 'blockquote') {
      const emptiedByRule = await normalizeBlockList(
        block.blocks,
        options,
        summary,
        budget,
        deleteIsolatedBlanks,
        checkpoint,
        depth + 1,
      );
      if (emptiedByRule && block.blocks.length === 0) {
        blocks.splice(index, 1);
        summary.emptyBlocksRemoved++;
        removedByRule = true;
        continue;
      }
    } else if (block.type === 'paragraph' || block.type === 'heading') {
      const changed = await normalizeInlineNodes(
        block.children,
        options,
        summary,
        budget,
        checkpoint,
      );
      if (changed && !isContentParagraph(block)) {
        blocks.splice(index, 1);
        summary.emptyBlocksRemoved++;
        removedByRule = true;
        continue;
      }
    } else if (block.type === 'imageBlock' && block.caption)
      await normalizeInlineNodes(
        block.caption,
        options,
        summary,
        budget,
        checkpoint,
      );
    index++;
  }
  return removedByRule;
}

async function normalizeInlineNodes(
  nodes: InlineNode[],
  options: ReturnType<typeof resolveOptions>,
  summary: TextNormalizationSummary,
  budget: WorkBudget,
  checkpoint: () => Promise<void>,
  depth = 0,
): Promise<boolean> {
  if (budget.exceeded || depth > 128) {
    budget.exceeded = true;
    return false;
  }
  let changed = false;
  let processed = 0;
  for (let index = 0; index < nodes.length; index++) {
    if (!visit(budget)) return changed;
    if (processed++ % 256 === 0) await checkpoint();
    const node = nodes[index];
    if (!node) continue;
    if (node.type === 'link') {
      const linkChanged = await normalizeInlineNodes(
        node.children,
        options,
        summary,
        budget,
        checkpoint,
        depth + 1,
      );
      changed ||= linkChanged;
      if (linkChanged && node.children.length === 0) {
        nodes.splice(index--, 1);
      }
      continue;
    }
    if (node.type !== 'text' || node.marks?.some(({ type }) => type === 'code'))
      continue;
    if (budget.text + node.text.length > MAX_TEXT_NORMALIZATION_TEXT) {
      budget.exceeded = true;
      return changed;
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
    let ruleChanged = false;
    if (
      budget.patterns.some(({ pattern }) => pattern) &&
      !budget.patternWorkLimitExceeded
    ) {
      const result = await applyTextRules(text, budget, checkpoint);
      text = result.text;
      ruleChanged = result.changed;
      changed ||= ruleChanged;
      summary.patternMatches += result.matches;
    }
    node.text = text;
    if (ruleChanged && text.length === 0) nodes.splice(index--, 1);
  }
  return changed;
}

const TEXT_URL = /(?:https?:\/\/|www\.)[^\s]+/giu;

async function applyTextRules(
  source: string,
  budget: WorkBudget,
  checkpoint: () => Promise<void>,
): Promise<{ text: string; changed: boolean; matches: number }> {
  let output = '';
  let sourceOffset = 0;
  let changed = false;
  let matches = 0;
  let checkedLines = 0;
  for (const line of source.split(/(\r?\n)/u)) {
    const lineStart = sourceOffset;
    sourceOffset += line.length;
    if (/^\r?\n$/u.test(line)) {
      output += line;
      continue;
    }
    if (!line) {
      output += line;
      continue;
    }
    if (checkedLines++ % 64 === 0) await checkpoint();
    if (
      ++budget.patternCandidateLines > MAX_TEXT_PATTERN_CANDIDATE_LINES ||
      line.length > MAX_TEXT_PATTERN_LINE_LENGTH ||
      Date.now() - budget.patternStartedAt > MAX_TEXT_PATTERN_WORK_MS
    ) {
      budget.patternWorkLimitExceeded = true;
      const ruleId = budget.patterns.find(({ pattern }) => pattern)?.id;
      if (ruleId && !budget.patternRejectedRuleIds.includes(ruleId))
        budget.patternRejectedRuleIds.push(ruleId);
      return {
        text: output + source.slice(lineStart),
        changed,
        matches,
      };
    }
    const urls = [...line.matchAll(TEXT_URL)];
    let lineIndex = 0;
    let transformedLine = '';
    let lineChanged = false;
    let lineMatches = 0;
    for (const url of urls) {
      const start = url.index!;
      const result = applyRulesToSegment(
        line.slice(lineIndex, start),
        budget,
        lineMatches,
      );
      if (result.exceeded) {
        budget.patternWorkLimitExceeded = true;
        return { text: output + source.slice(lineStart), changed, matches };
      }
      transformedLine += result.text;
      lineMatches += result.matches;
      lineChanged ||= result.changed;
      transformedLine += url[0];
      lineIndex = start + url[0].length;
    }
    const result = applyRulesToSegment(
      line.slice(lineIndex),
      budget,
      lineMatches,
    );
    if (result.exceeded) {
      budget.patternWorkLimitExceeded = true;
      return { text: output + source.slice(lineStart), changed, matches };
    }
    transformedLine += result.text;
    lineMatches += result.matches;
    lineChanged ||= result.changed;
    if (
      budget.patternOutputCharacters + transformedLine.length >
      MAX_TEXT_NORMALIZATION_TEXT
    ) {
      budget.patternWorkLimitExceeded = true;
      const ruleId = budget.patterns.find(({ pattern }) => pattern)?.id;
      if (ruleId && !budget.patternRejectedRuleIds.includes(ruleId))
        budget.patternRejectedRuleIds.push(ruleId);
      return { text: output + source.slice(lineStart), changed, matches };
    }
    output += transformedLine;
    matches += lineMatches;
    changed ||= lineChanged;
    budget.patternMatches += lineMatches;
    budget.patternOutputCharacters += transformedLine.length;
  }
  return { text: output, changed, matches };
}

function applyRulesToSegment(
  source: string,
  budget: WorkBudget,
  alreadyMatched: number,
): { text: string; matches: number; changed: boolean; exceeded: boolean } {
  let text = source;
  let totalMatches = 0;
  for (const rule of budget.patterns) {
    if (!rule.pattern || budget.patternWorkLimitExceeded) continue;
    if (Date.now() - budget.patternStartedAt > MAX_TEXT_PATTERN_WORK_MS) {
      if (!budget.patternRejectedRuleIds.includes(rule.id))
        budget.patternRejectedRuleIds.push(rule.id);
      return { text: source, matches: 0, changed: false, exceeded: true };
    }
    const pattern = rule.pattern;
    pattern.lastIndex = 0;
    let output = '';
    let cursor = 0;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        if (!budget.patternRejectedRuleIds.includes(rule.id))
          budget.patternRejectedRuleIds.push(rule.id);
        return { text: source, matches: 0, changed: false, exceeded: true };
      }
      if (
        budget.patternMatches + alreadyMatched + totalMatches + count >
        MAX_TEXT_PATTERN_MATCHES
      ) {
        if (!budget.patternRejectedRuleIds.includes(rule.id))
          budget.patternRejectedRuleIds.push(rule.id);
        return { text: source, matches: 0, changed: false, exceeded: true };
      }
      output += text.slice(cursor, match.index) + rule.replace;
      cursor = match.index + match[0].length;
      count++;
    }
    if (count > 0) {
      text = output + text.slice(cursor);
      totalMatches += count;
    }
  }
  return {
    text,
    matches: totalMatches,
    changed: text !== source,
    exceeded: false,
  };
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
  summary.patternRulesRejected = budget.patternRulesRejected;
  summary.patternRejectedRuleIds = [
    ...new Set(budget.patternRejectedRuleIds),
  ].join(',');
  summary.patternWorkLimitExceeded = budget.patternWorkLimitExceeded;
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
  const budget = createWorkBudget(resolved, summary);
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
  const budget = createWorkBudget(resolved, summary);
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
  const hasPatternWarnings =
    summary.patternRulesRejected > 0 || summary.patternWorkLimitExceeded;
  return {
    code: 'text-normalization-summary',
    severity: summary.budgetExceeded || hasPatternWarnings ? 'warning' : 'info',
    message:
      summary.patternRulesRejected > 0
        ? `Text pattern rules rejected: ${summary.patternRejectedRuleIds}.`
        : summary.patternWorkLimitExceeded
          ? `Text pattern work limit reached; remaining text was preserved. Rule: ${summary.patternRejectedRuleIds}.`
          : summary.budgetExceeded
            ? 'Text normalization reached its work limit; remaining text was preserved.'
            : 'Text normalization completed with the reported changes.',
    details: {
      ...summary,
      ...(summary.patternRejectedRuleIds
        ? { patternRejectedRuleIds: summary.patternRejectedRuleIds }
        : {}),
    },
  };
}
