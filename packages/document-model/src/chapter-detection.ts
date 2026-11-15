import type { BlockNode, InlineNode, ValidationIssue } from './index.ts';

export type ChapterHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type ChapterDetectionMode = 'off' | 'automatic' | 'custom';
export type ChapterMark = 'pagebreak' | 'rule' | 'none' | 'both';

export interface ChapterDetectionOptions {
  mode: ChapterDetectionMode;
  headingLevels: ChapterHeadingLevel[];
  keywords: string[];
  styleIds?: string[];
  patterns?: string[];
}

export const DEFAULT_CHAPTER_DETECTION: ChapterDetectionOptions = {
  mode: 'automatic',
  headingLevels: [1, 2],
  keywords: ['chapter', 'book', 'section', 'prologue', 'epilogue', 'part'],
};

export const CHAPTER_MARKS = [
  'pagebreak',
  'rule',
  'none',
  'both',
] as const satisfies readonly ChapterMark[];

export interface ChapterDetectionValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateChapterDetection(
  value: unknown,
): ChapterDetectionValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainRecord(value))
    return {
      valid: false,
      issues: [{ path: '', code: 'type', message: 'Expected an object.' }],
    };

  for (const key of Object.keys(value))
    if (
      !['mode', 'headingLevels', 'keywords', 'styleIds', 'patterns'].includes(
        key,
      )
    )
      issues.push({
        path: key,
        code: 'unknown',
        message: 'Unknown chapter detection option.',
      });

  if (!['off', 'automatic', 'custom'].includes(String(value.mode)))
    issues.push({
      path: 'mode',
      code: 'enum',
      message: 'Expected off, automatic, or custom.',
    });

  if (!Array.isArray(value.headingLevels) || value.headingLevels.length === 0)
    issues.push({
      path: 'headingLevels',
      code: 'shape',
      message: 'Expected at least one heading level from 1 to 6.',
    });
  else {
    const seen = new Set<number>();
    for (const [index, level] of value.headingLevels.entries()) {
      if (
        typeof level !== 'number' ||
        !Number.isInteger(level) ||
        level < 1 ||
        level > 6 ||
        seen.has(level)
      )
        issues.push({
          path: `headingLevels.${index}`,
          code: 'range',
          message: 'Expected a unique heading level from 1 to 6.',
        });
      else seen.add(level);
    }
  }

  validateStringArray(value.keywords, 'keywords', 32, 64, issues);
  validateStringArray(value.styleIds, 'styleIds', 100, 128, issues, true);
  if (value.patterns !== undefined) {
    if (!Array.isArray(value.patterns) || value.patterns.length > 10)
      issues.push({
        path: 'patterns',
        code: 'limit',
        message: 'Expected at most 10 bounded patterns.',
      });
    else
      for (const [index, pattern] of value.patterns.entries()) {
        if (
          typeof pattern !== 'string' ||
          pattern.length === 0 ||
          pattern.length > 128 ||
          !isBoundedPattern(pattern)
        ) {
          issues.push({
            path: `patterns.${index}`,
            code: 'pattern',
            message:
              'Patterns must be at most 128 characters and cannot use backreferences, groups, alternation, or multiple quantifiers.',
          });
          continue;
        }
        try {
          new RegExp(pattern, 'iu');
        } catch {
          issues.push({
            path: `patterns.${index}`,
            code: 'pattern',
            message: 'Pattern is not a valid regular expression.',
          });
        }
      }
  }
  return { valid: issues.length === 0, issues };
}

export function isChapterMark(value: unknown): value is ChapterMark {
  return (
    typeof value === 'string' &&
    (CHAPTER_MARKS as readonly string[]).includes(value)
  );
}

export function mergeHeadingRuns(blocks: readonly BlockNode[]): {
  blocks: BlockNode[];
  mergedRuns: number;
} {
  const merged: BlockNode[] = [];
  let mergedRuns = 0;
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (
      block.type === 'heading' &&
      previous?.type === 'heading' &&
      block.level === previous.level
    ) {
      previous.children.push(
        ...(block.numbering && block.numbering !== previous.numbering
          ? [{ type: 'text' as const, text: `${block.numbering} ` }]
          : [{ type: 'text' as const, text: ' ' }]),
        ...block.children,
      );
      if (previous.id === undefined && block.id !== undefined)
        previous.id = block.id;
      mergedRuns++;
    } else {
      merged.push(
        block.type === 'heading'
          ? { ...block, children: [...block.children] }
          : block,
      );
    }
  }
  return { blocks: merged, mergedRuns };
}

export function applyChapterMarks(
  blocks: readonly BlockNode[],
  level: ChapterHeadingLevel,
  mark: ChapterMark,
): BlockNode[] {
  if (mark === 'none') return [...blocks];
  const output: BlockNode[] = [];
  let hasChapterHeading = false;
  let wordsSinceHeading = 0;
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === level) {
      if (hasChapterHeading && wordsSinceHeading >= 50) {
        if (mark === 'pagebreak' || mark === 'both')
          output.push({ type: 'pageBreak' });
        if (mark === 'rule' || mark === 'both')
          output.push({ type: 'thematicBreak' });
      }
      hasChapterHeading = true;
      wordsSinceHeading = 0;
    } else if (hasChapterHeading) {
      wordsSinceHeading += wordCount(blockText(block));
    }
    output.push(block);
  }
  return output;
}

export function countChapterGroups(
  blocks: readonly BlockNode[],
  level: ChapterHeadingLevel,
): number {
  let hasChapterHeading = false;
  let wordsSinceHeading = 0;
  let count = 1;
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === level) {
      if (hasChapterHeading && wordsSinceHeading >= 50) count++;
      hasChapterHeading = true;
      wordsSinceHeading = 0;
    } else if (hasChapterHeading) {
      wordsSinceHeading += wordCount(blockText(block));
    }
  }
  return count;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function blockText(block: BlockNode): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.children);
    case 'list':
      return block.items
        .flatMap((item) => item.blocks.map(blockText))
        .join(' ');
    case 'table':
      return [
        ...(block.caption ? [inlineText(block.caption)] : []),
        ...block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => cell.blocks.map(blockText)),
        ),
      ].join(' ');
    case 'blockquote':
      return block.blocks.map(blockText).join(' ');
    case 'codeBlock':
      return block.text;
    case 'equationBlock':
    case 'imageBlock':
    case 'thematicBreak':
    case 'pageBreak':
      return '';
  }
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.type === 'link'
          ? inlineText(node.children)
          : '',
    )
    .join('');
}

function validateStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
  issues: ValidationIssue[],
  optional = false,
): void {
  if (value === undefined && optional) return;
  if (!Array.isArray(value) || value.length > maxItems) {
    issues.push({
      path,
      code: 'limit',
      message: `Expected at most ${maxItems} strings.`,
    });
    return;
  }
  for (const [index, item] of value.entries())
    if (
      typeof item !== 'string' ||
      item.trim().length === 0 ||
      item.length > maxLength
    )
      issues.push({
        path: `${path}.${index}`,
        code: 'string',
        message: `Expected a non-empty string of at most ${maxLength} characters.`,
      });
}

function isBoundedPattern(pattern: string): boolean {
  if (/\\[1-9]|[|()]/u.test(pattern)) return false;
  const quantifiers = pattern.match(/[+*?]|\{\d+(?:,\d*)?\}/gu) ?? [];
  return quantifiers.length <= 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
