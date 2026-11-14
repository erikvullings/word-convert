/**
 * Tagged-PDF table extraction.
 *
 * A tagged PDF states its tables in the structure tree (`Table` with `TR`
 * descendants and `TH`/`TD`/`TC` cells), which is an exact source of truth
 * unlike column-alignment guessing. This module turns that declaration into a
 * grid of spans; the reader owns inline and style creation so table cells share
 * the formatting path of every other block.
 *
 * Ruled-line and borderless table detection are deliberately absent here; see
 * TASKS/0045-detect-pdf-tables-and-emit-table-node.md for those slices.
 */

export interface TaggedStructureNode {
  readonly role?: string;
  readonly markedContentId?: string;
  readonly children?: readonly TaggedStructureNode[];
}

export interface TaggedTableCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly role: string;
  readonly header: boolean;
  /** Marked-content ids that hold this cell's text, in structure order. */
  readonly markedContentIds: readonly string[];
}

export interface TaggedTableRow {
  readonly cells: readonly TaggedTableCell[];
}

export interface TaggedTable {
  readonly id: string;
  readonly role: string;
  readonly rows: readonly TaggedTableRow[];
  /** Marked-content ids of `Caption` descendants of the `Table` element. */
  readonly captionMarkedContentIds: readonly string[];
}

export interface TaggedTableDiscovery {
  readonly tables: readonly TaggedTable[];
  /** Structure roots that look like tables but could not be read as one. */
  readonly unresolved: number;
}

export interface TaggedTableLimits {
  readonly maxTablesPerPage: number;
  readonly maxRowsPerTable: number;
  readonly maxCellsPerRow: number;
  readonly maxNodes: number;
}

export const DEFAULT_TAGGED_TABLE_LIMITS: TaggedTableLimits = {
  maxTablesPerPage: 16,
  maxRowsPerTable: 500,
  maxCellsPerRow: 64,
  maxNodes: 4_000,
};

const ROW_ROLE = 'TR';
const CELL_ROLES = new Set(['TH', 'TD', 'TC']);
const TABLE_ROLE = 'TABLE';
const CAPTION_ROLE = 'CAPTION';
/** Bucket key under which caption spans are stored for a table. */
export const TAGGED_TABLE_CAPTION_KEY = 'caption';

const isHeaderRole = (role: string): boolean => role === 'TH';

interface CellAccumulator {
  readonly role: string;
  readonly markedContentIds: string[];
}

/** Collect span ids of marked content below a structural element, in tree order. */
function collectMarks(
  nodes: readonly TaggedStructureNode[],
  limits: TaggedTableLimits,
  state: { visited: number },
): string[] {
  const markedContentIds: string[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    state.visited += 1;
    if (state.visited > limits.maxNodes) return markedContentIds;
    const node = pending.pop();
    if (!node) continue;
    const role = (node.role ?? '').toUpperCase();
    if (node.markedContentId !== undefined && role !== ROW_ROLE) {
      markedContentIds.push(node.markedContentId);
      continue;
    }
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      const child = node.children?.[index];
      if (child) pending.push(child);
    }
  }
  return markedContentIds;
}

/**
 * Walk a `TR` element and return its cells in document order. Empty cells are
 * kept with no spans so the grid stays rectangular where the PDF declares it.
 */
function collectCells(
  rowNode: TaggedStructureNode,
  limits: TaggedTableLimits,
  state: { visited: number },
): CellAccumulator[] | undefined {
  const cells: CellAccumulator[] = [];
  const descend = (nodes: readonly TaggedStructureNode[]): void => {
    for (const node of nodes) {
      state.visited += 1;
      if (state.visited > limits.maxNodes) return;
      const role = (node.role ?? '').toUpperCase();
      if (role === ROW_ROLE) continue;
      if (CELL_ROLES.has(role)) {
        if (cells.length >= limits.maxCellsPerRow) return;
        cells.push({
          role,
          markedContentIds: collectMarks(node.children ?? [], limits, state),
        });
        continue;
      }
      descend(node.children ?? []);
    }
  };
  descend(rowNode.children ?? []);
  return cells.length > 0 ? cells : undefined;
}

interface RawTable {
  readonly role: string;
  readonly rows: CellAccumulator[][];
  readonly captionMarkedContentIds: string[];
}

/** Read a `Table` element (or table-like ancestor) into a row/cell grid. */
function readTable(
  node: TaggedStructureNode,
  limits: TaggedTableLimits,
  state: { visited: number },
): RawTable | undefined {
  const rows: CellAccumulator[][] = [];
  const captionMarkedContentIds: string[] = [];
  const descend = (nodes: readonly TaggedStructureNode[]): void => {
    for (const child of nodes) {
      state.visited += 1;
      if (state.visited > limits.maxNodes) return;
      const role = (child.role ?? '').toUpperCase();
      if (role === ROW_ROLE) {
        if (rows.length >= limits.maxRowsPerTable) return;
        const cells = collectCells(child, limits, state);
        if (cells) rows.push(cells);
        continue;
      }
      if (role === CAPTION_ROLE) {
        captionMarkedContentIds.push(...collectMarks([child], limits, state));
        continue;
      }
      descend(child.children ?? []);
    }
  };
  descend(node.children ?? []);
  if (rows.length === 0) return undefined;
  return {
    role: (node.role ?? 'Table').trim() || 'Table',
    rows,
    captionMarkedContentIds,
  };
}

/**
 * Find declared tables in a page's structure tree. Only structures with at
 * least one `TR` descendant qualify, so arbitrary grouped text never becomes a
 * table. `unresolved` counts table-like roots that produced no grid.
 */
export function detectTaggedTables(
  structure: TaggedStructureNode | undefined,
  limits: TaggedTableLimits = DEFAULT_TAGGED_TABLE_LIMITS,
): TaggedTableDiscovery {
  const tables: TaggedTable[] = [];
  let unresolved = 0;
  if (!structure || limits.maxTablesPerPage <= 0) return { tables, unresolved };
  const state = { visited: 0 };
  const pending: TaggedStructureNode[] = [structure];
  while (pending.length > 0) {
    state.visited += 1;
    if (state.visited > limits.maxNodes) break;
    const node = pending.shift();
    if (!node) continue;
    const role = (node.role ?? '').toUpperCase();
    const isTableRoot = role === TABLE_ROLE;
    const looksLikeTable = isTableRoot || role.startsWith('TABLE');
    if (looksLikeTable) {
      if (tables.length >= limits.maxTablesPerPage) break;
      const raw = readTable(node, limits, state);
      if (!raw) {
        unresolved += 1;
        continue;
      }
      const id = `tagged-table-${tables.length}`;
      tables.push({
        id,
        role: raw.role,
        captionMarkedContentIds: raw.captionMarkedContentIds,
        rows: raw.rows.map((cells, rowIndex) => ({
          cells: cells.map((cell, columnIndex) => ({
            rowIndex,
            columnIndex,
            role: cell.role,
            header: isHeaderRole(cell.role),
            markedContentIds: cell.markedContentIds,
          })),
        })),
      });
      // Cell and row content of an accepted table is fully consumed.
      continue;
    }
    for (const child of node.children ?? []) pending.push(child);
  }
  return { tables, unresolved };
}

export interface TaggedTableLayout {
  /**
   * Retained marked-content ids per emittable table and cell key (`row:cell`).
   * A table is absent when any cell lost all its text to cropping or furniture
   * removal, so a half-understood table can never swallow part of its text.
   */
  readonly complete: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
  /** Retained caption marked-content ids per emittable table. */
  readonly captions: ReadonlyMap<string, readonly string[]>;
  /** Every marked-content id claimed by an emittable table. */
  readonly marks: ReadonlySet<string>;
  /** Tables dropped because they could not be completed from retained text. */
  readonly unresolved: number;
}

/**
 * Decide which declared tables survive against the text the reader actually
 * kept. Cells are resolved from spans rather than lines: a PDF routinely
 * renders a whole row as one text run, so `Period` and `Revenue` can share a
 * line while belonging to different cells.
 */
export function layoutTaggedTables(
  tables: readonly TaggedTable[],
  retainedMarks: ReadonlySet<string>,
): TaggedTableLayout {
  const complete = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const captions = new Map<string, readonly string[]>();
  const marks = new Set<string>();
  let unresolved = 0;
  for (const table of tables) {
    if (table.rows.length === 0) {
      unresolved += 1;
      continue;
    }
    const cells = new Map<string, readonly string[]>();
    let dropped = false;
    const columnCount = table.rows[0]!.cells.length;
    if (table.rows.some((row) => row.cells.length !== columnCount)) {
      // A ragged declaration cannot be turned into a grid without guessing how
      // the missing cells were meant to span, so the text stays as paragraphs.
      unresolved += 1;
      continue;
    }
    table.rows.forEach((row, rowIndex) => {
      if (dropped) return;
      row.cells.forEach((cell, cellIndex) => {
        if (dropped) return;
        const present = cell.markedContentIds.filter((mark) =>
          retainedMarks.has(mark),
        );
        if (present.length === 0) dropped = true;
        else cells.set(`${rowIndex}:${cellIndex}`, present);
      });
    });
    if (dropped) {
      unresolved += 1;
      continue;
    }
    complete.set(table.id, cells);
    const caption = table.captionMarkedContentIds.filter((mark) =>
      retainedMarks.has(mark),
    );
    if (caption.length > 0) captions.set(table.id, caption);
    for (const ids of cells.values()) for (const id of ids) marks.add(id);
    for (const id of caption) marks.add(id);
  }
  return { complete, captions, marks, unresolved };
}

export interface TaggedTableBuild {
  readonly rows: readonly { readonly cells: readonly unknown[] }[];
  readonly columnCount: number;
  readonly caption?: readonly unknown[];
}

/**
 * Assemble the document-model table once every cell has its blocks. Returns
 * `undefined` when any cell has no blocks, keeping the all-or-nothing rule in
 * one place instead of in each caller.
 */
export function buildTaggedTable(
  table: TaggedTable,
  cellBlocks: (rowIndex: number, columnIndex: number) => readonly unknown[],
  captionBlocks: () => readonly unknown[] | undefined,
): TaggedTableBuild | undefined {
  const rows: { cells: unknown[] }[] = [];
  for (const row of table.rows) {
    const cells: unknown[] = [];
    for (const cell of row.cells) {
      const blocks = cellBlocks(cell.rowIndex, cell.columnIndex);
      if (blocks.length === 0) return undefined;
      cells.push(
        blocks.length > 0
          ? { blocks, ...(cell.header ? { header: true } : {}) }
          : { blocks: [] as unknown[] },
      );
    }
    rows.push({ cells });
  }
  const caption = captionBlocks();
  return {
    rows,
    columnCount: Math.max(...table.rows.map((row) => row.cells.length)),
    ...(caption && caption.length > 0 ? { caption } : {}),
  };
}
