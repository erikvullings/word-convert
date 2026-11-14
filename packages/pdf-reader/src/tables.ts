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
  /** Declared `/ColSpan` of a `TH`/`TD`, present only when greater than one. */
  readonly colSpan?: number;
  /** Declared `/RowSpan` of a `TH`/`TD`, present only when greater than one. */
  readonly rowSpan?: number;
  readonly children?: readonly TaggedStructureNode[];
}

export interface TaggedTableCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly role: string;
  readonly header: boolean;
  readonly colSpan: number;
  readonly rowSpan: number;
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
const HEAD_ROLE = 'THEAD';
/** Bucket key under which caption spans are stored for a table. */
export const TAGGED_TABLE_CAPTION_KEY = 'caption';

const isHeaderRole = (role: string): boolean => role === 'TH';

/** Declared spans are trusted but bounded: an absurd value is a broken PDF. */
const declaredSpan = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const span = Math.floor(value);
  if (span < 1) return fallback;
  return Math.min(span, maximum);
};

interface CellAccumulator {
  readonly role: string;
  readonly header: boolean;
  readonly colSpan: number;
  readonly rowSpan: number;
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
 * Cells of a `THead` row are headers even when their role is `TD`, because the
 * section states the meaning.
 */
function collectCells(
  rowNode: TaggedStructureNode,
  limits: TaggedTableLimits,
  state: { visited: number },
  inHead: boolean,
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
          header: inHead || isHeaderRole(role),
          colSpan: declaredSpan(node.colSpan, 1, limits.maxCellsPerRow),
          rowSpan: declaredSpan(node.rowSpan, 1, limits.maxRowsPerTable),
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
  const descend = (
    nodes: readonly TaggedStructureNode[],
    inHead = false,
  ): void => {
    for (const child of nodes) {
      state.visited += 1;
      if (state.visited > limits.maxNodes) return;
      const role = (child.role ?? '').toUpperCase();
      if (role === ROW_ROLE) {
        if (rows.length >= limits.maxRowsPerTable) return;
        const cells = collectCells(child, limits, state, inHead);
        if (cells) rows.push(cells);
        continue;
      }
      if (role === CAPTION_ROLE) {
        captionMarkedContentIds.push(...collectMarks([child], limits, state));
        continue;
      }
      descend(child.children ?? [], inHead || role === HEAD_ROLE);
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
            header: cell.header,
            colSpan: cell.colSpan,
            rowSpan: cell.rowSpan,
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

export interface TaggedTablePlacedCell {
  /** Grid position of the cell, as `row:column`. */
  readonly key: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly header: boolean;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly markedContentIds: readonly string[];
}

export interface TaggedTablePlacement {
  readonly rows: readonly (readonly TaggedTablePlacedCell[])[];
  readonly columnCount: number;
}

/**
 * Turn declared cells into grid positions. A row that starts later than column
 * zero is legitimate when the cell above spans down, so raggedness alone is not
 * a reason to reject a table; two cells claiming one position, or a position no
 * cell claims, is.
 */
export function placeCells(
  table: TaggedTable,
  limits: TaggedTableLimits = DEFAULT_TAGGED_TABLE_LIMITS,
): TaggedTablePlacement | undefined {
  const rowCount = table.rows.length;
  if (rowCount === 0) return undefined;
  const occupied = new Set<string>();
  const rows: TaggedTablePlacedCell[][] = [];
  let columnCount = 0;
  for (const row of table.rows) {
    const cells: TaggedTablePlacedCell[] = [];
    let column = 0;
    for (const cell of row.cells) {
      while (occupied.has(`${cell.rowIndex}:${column}`)) column += 1;
      const colSpan = declaredSpan(cell.colSpan, 1, limits.maxCellsPerRow);
      const rowSpan = Math.min(
        declaredSpan(cell.rowSpan, 1, limits.maxRowsPerTable),
        rowCount - cell.rowIndex,
      );
      for (let offset = 0; offset < rowSpan; offset++)
        for (let width = 0; width < colSpan; width++) {
          const key = `${cell.rowIndex + offset}:${column + width}`;
          // Two cells claim this position: the declaration contradicts itself
          // and no amount of guessing produces the author's table.
          if (occupied.has(key)) return undefined;
          occupied.add(key);
        }
      cells.push({
        key: `${cell.rowIndex}:${column}`,
        rowIndex: cell.rowIndex,
        columnIndex: column,
        header: cell.header,
        colSpan,
        rowSpan,
        markedContentIds: cell.markedContentIds,
      });
      column += colSpan;
    }
    if (column > limits.maxCellsPerRow) return undefined;
    columnCount = Math.max(columnCount, column);
    rows.push(cells);
  }
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++)
    for (let column = 0; column < columnCount; column++)
      if (!occupied.has(`${rowIndex}:${column}`)) return undefined;
  return { rows, columnCount };
}

export interface TaggedTableLayout {
  /**
   * Grid positions per emittable table, in structure order. A table is absent
   * when its declaration contradicts itself or a cell lost all its text to
   * cropping or furniture removal, so a half-understood table can never
   * swallow part of its text.
   */
  readonly placements: ReadonlyMap<string, TaggedTablePlacement>;
  /**
   * Retained marked-content ids per emittable table and grid position.
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
  limits: TaggedTableLimits = DEFAULT_TAGGED_TABLE_LIMITS,
): TaggedTableLayout {
  const placements = new Map<string, TaggedTablePlacement>();
  const complete = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const captions = new Map<string, readonly string[]>();
  const marks = new Set<string>();
  let unresolved = 0;
  for (const table of tables) {
    const placement = placeCells(table, limits);
    if (!placement) {
      unresolved += 1;
      continue;
    }
    const cells = new Map<string, readonly string[]>();
    let dropped = false;
    for (const row of placement.rows)
      for (const cell of row) {
        if (dropped) continue;
        // A cell that declares no content at all is a blank cell, which is
        // normal in a spreadsheet print. A cell that declares content the
        // reader no longer has is a different matter: the table is not safe.
        if (cell.markedContentIds.length === 0) {
          cells.set(cell.key, []);
          continue;
        }
        const present = cell.markedContentIds.filter((mark) =>
          retainedMarks.has(mark),
        );
        if (present.length === 0) dropped = true;
        else cells.set(cell.key, present);
      }
    if (dropped) {
      unresolved += 1;
      continue;
    }
    placements.set(table.id, placement);
    complete.set(table.id, cells);
    const caption = table.captionMarkedContentIds.filter((mark) =>
      retainedMarks.has(mark),
    );
    if (caption.length > 0) captions.set(table.id, caption);
    for (const ids of cells.values()) for (const id of ids) marks.add(id);
    for (const id of caption) marks.add(id);
  }
  return { placements, complete, captions, marks, unresolved };
}

export interface TaggedTableBuild {
  readonly rows: readonly { readonly cells: readonly unknown[] }[];
  readonly columnCount: number;
  readonly caption?: readonly unknown[];
}

/**
 * Assemble the document-model table from placed cells. Spans are emitted only
 * because the source declared them, and a cell with no content stays an empty
 * cell rather than becoming invented text.
 */
export function buildTaggedTable(
  placement: TaggedTablePlacement,
  cellBlocks: (key: string) => readonly unknown[],
  captionBlocks: () => readonly unknown[] | undefined,
): TaggedTableBuild {
  const rows: { cells: unknown[] }[] = [];
  for (const row of placement.rows) {
    const cells: unknown[] = [];
    for (const cell of row) {
      const blocks = cellBlocks(cell.key);
      cells.push({
        blocks,
        ...(cell.header ? { header: true } : {}),
        ...(cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}),
        ...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
      });
    }
    rows.push({ cells });
  }
  const caption = captionBlocks();
  return {
    rows,
    columnCount: placement.columnCount,
    ...(caption && caption.length > 0 ? { caption } : {}),
  };
}
