import type { BlockNode, InlineNode } from '@wordconvert/document-model';

export const MAX_PDF_WORD_EVIDENCE = 250_000;
const WORD = /[\p{L}\p{M}]+/gu;
const HYPHENATED_WORD = /([\p{L}\p{M}]{2,})-([\p{L}\p{M}]{2,})/gu;
const URL = /(?:https?:\/\/|www\.)\S+/giu;
const LATIN_FRAGMENT = /^\p{Script=Latin}[\p{Script=Latin}\p{M}]*$/u;

export interface WordEvidence {
  words: ReadonlyMap<string, number>;
  hyphenated: ReadonlyMap<string, number>;
  limitExceeded: boolean;
}

export interface DehyphenationSummary {
  joined: number;
  kept: number;
  limitExceeded: boolean;
}

export async function collectWordEvidence(
  texts: Iterable<string>,
  checkpoint: () => Promise<void>,
): Promise<WordEvidence> {
  const words = new Map<string, number>();
  const hyphenated = new Map<string, number>();
  let tokenCount = 0;
  let textIndex = 0;
  for (const source of texts) {
    if (textIndex++ % 250 === 0) await checkpoint();
    const text = source.normalize('NFC');
    for (const match of text.matchAll(WORD)) {
      if (++tokenCount > MAX_PDF_WORD_EVIDENCE)
        return { words: new Map(), hyphenated: new Map(), limitExceeded: true };
      increment(words, match[0]!.toLocaleLowerCase('en'));
      if (tokenCount % 2_000 === 0) await checkpoint();
    }
    for (const match of text.matchAll(HYPHENATED_WORD)) {
      const left = match[1]!;
      const right = match[2]!;
      if (!isSafeFragment(left) || !isSafeFragment(right)) continue;
      increment(
        hyphenated,
        `${left}-${right}`.normalize('NFC').toLocaleLowerCase('en'),
      );
    }
  }
  return { words, hyphenated, limitExceeded: false };
}

export function resolveLineHyphenation(
  previous: string,
  current: string,
  evidence: WordEvidence,
): 'joined' | 'kept' | undefined {
  if (/[\p{L}\p{M}]+\u00ad\s*$/u.test(previous)) return 'joined';
  const left =
    /(\p{Script=Latin}[\p{Script=Latin}\p{M}]{1,})[\u00ad-]\s*[—–]?\s*$/u.exec(
      previous,
    )?.[1];
  const right = /^\s*(\p{Script=Latin}[\p{Script=Latin}\p{M}]{1,})/u.exec(
    current,
  )?.[1];
  if (!left || !right) return undefined;
  return shouldJoin(left, right, evidence) ? 'joined' : 'kept';
}

export async function dehyphenateBodyBlocks(
  blocks: BlockNode[],
  bodyStyleIds: ReadonlySet<string>,
  evidence: WordEvidence,
  checkpoint: () => Promise<void>,
): Promise<DehyphenationSummary> {
  const summary: DehyphenationSummary = {
    joined: 0,
    kept: 0,
    limitExceeded: evidence.limitExceeded,
  };
  let processed = 0;
  const visitBlocks = async (items: BlockNode[]): Promise<void> => {
    for (const block of items) {
      if (processed++ % 250 === 0) await checkpoint();
      if (block.type === 'paragraph') {
        if (!block.styleId || bodyStyleIds.has(block.styleId))
          await normalizeInlineNodes(
            block.children,
            evidence,
            summary,
            checkpoint,
          );
      } else if (block.type === 'list') {
        for (const item of block.items) await visitBlocks(item.blocks);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) await visitBlocks(cell.blocks);
      } else if (block.type === 'blockquote') await visitBlocks(block.blocks);
    }
  };
  await visitBlocks(blocks);
  return summary;
}

export function removeTextSuffix(nodes: InlineNode[], length: number): boolean {
  let remaining = length;
  for (let index = nodes.length - 1; index >= 0 && remaining > 0; index--) {
    const node = nodes[index];
    if (node?.type !== 'text') return false;
    const removed = Math.min(remaining, node.text.length);
    node.text = node.text.slice(0, node.text.length - removed);
    remaining -= removed;
    if (!node.text) nodes.splice(index, 1);
  }
  return remaining === 0;
}

async function normalizeInlineNodes(
  nodes: InlineNode[],
  evidence: WordEvidence,
  summary: DehyphenationSummary,
  checkpoint: () => Promise<void>,
): Promise<void> {
  for (let index = 0; index < nodes.length; index++) {
    if (index % 250 === 0) await checkpoint();
    const node = nodes[index];
    if (
      node?.type !== 'text' ||
      node.marks?.some(({ type }) => type === 'code')
    )
      continue;
    const softHyphens = node.text.match(/\u00ad/gu)?.length ?? 0;
    let text = node.text.replace(/\u00ad/gu, '');
    summary.joined += softHyphens;
    node.text = text;
    if (evidence.limitExceeded) {
      node.text = replaceOutsideUrls(text, (candidate) => {
        summary.kept++;
        return candidate;
      });
      continue;
    }
    text = replaceOutsideUrls(text, (candidate, left, right) => {
      if (shouldJoin(left, right, evidence)) {
        summary.joined++;
        return left + right;
      }
      summary.kept++;
      return candidate;
    });
    node.text = text;
  }
}

function replaceOutsideUrls(
  text: string,
  replace: (candidate: string, left: string, right: string) => string,
): string {
  const urls = [...text.matchAll(URL)].map(
    (match) => [match.index!, match.index! + match[0].length] as const,
  );
  let urlIndex = 0;
  return text.replace(
    HYPHENATED_WORD,
    (candidate, left: string, right: string, offset: number) => {
      while (urlIndex < urls.length && urls[urlIndex]![1] <= offset) urlIndex++;
      const url = urls[urlIndex];
      if (url && offset < url[1] && offset + candidate.length > url[0])
        return candidate;
      if (!isSafeFragment(left) || !isSafeFragment(right)) return candidate;
      return replace(candidate, left, right);
    },
  );
}

function shouldJoin(
  left: string,
  right: string,
  evidence: WordEvidence,
): boolean {
  if (evidence.limitExceeded || !isSafeFragment(left) || !isSafeFragment(right))
    return false;
  const joined = `${left}${right}`.normalize('NFC');
  if ([...joined].length < 7) return false;
  const lowerJoined = joined.toLocaleLowerCase('en');
  const hyphenated = `${left}-${right}`
    .normalize('NFC')
    .toLocaleLowerCase('en');
  const joinedCount = evidence.words.get(lowerJoined) ?? 0;
  const hyphenatedCount = evidence.hyphenated.get(hyphenated) ?? 0;
  return !(joinedCount === 0 || (hyphenatedCount >= 2 && joinedCount >= 2));
}

function isSafeFragment(value: string): boolean {
  return LATIN_FRAGMENT.test(value.normalize('NFC'));
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
