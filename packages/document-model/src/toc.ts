import type { BlockNode, InlineNode, Provenance, TocEntry } from './index.ts';

export interface NestedTocEntry extends TocEntry {
  children: NestedTocEntry[];
}

export function createTocFromHeadings(
  blocks: readonly BlockNode[],
): TocEntry[] {
  const entries: TocEntry[] = [];
  const ids = new Map<string, number>();
  const visit = (nodes: readonly BlockNode[]): void => {
    for (const block of nodes) {
      if (block.type === 'heading') {
        const label = inlineText(block.children).trim();
        if (label) {
          const base = safeId(block.id ?? label);
          const count = (ids.get(base) ?? 0) + 1;
          ids.set(base, count);
          const target = count === 1 ? base : `${base}-${count}`;
          block.id = target;
          const provenance: Provenance = block.provenance ?? {
            source: 'semantic-heading',
            method: 'inferred',
            confidence: 'high',
          };
          entries.push({
            label: block.numbering ? `${block.numbering} ${label}` : label,
            target,
            level: block.level,
            provenance,
            confidence: provenance.confidence,
          });
        }
      } else if (block.type === 'list') {
        for (const item of block.items) visit(item.blocks);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) visit(cell.blocks);
      } else if (block.type === 'blockquote') visit(block.blocks);
    }
  };
  visit(blocks);
  return entries;
}

export function nestTocEntries(entries: readonly TocEntry[]): NestedTocEntry[] {
  const roots: NestedTocEntry[] = [];
  const parents: NestedTocEntry[] = [];
  for (const entry of entries.slice(0, 500)) {
    const level = Math.max(1, Math.min(6, Math.floor(entry.level)));
    const node: NestedTocEntry = { ...entry, level, children: [] };
    while ((parents.at(-1)?.level ?? 0) >= level) parents.pop();
    const parent = parents.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    parents.push(node);
  }
  return roots;
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

function safeId(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}
