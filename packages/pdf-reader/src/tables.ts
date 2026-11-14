/**
 * Tagged-PDF table extraction.
 *
 * A tagged PDF states its tables in the structure tree (`Table` with `TR`
 * descendants and `TH`/`TD`/`TC` cells), which is an exact source of truth
 * unlike column-alignment guessing. This module turns that declaration into a
 * grid of spans; the reader owns inline and style creation so table cells share
 * the formatting path of every other block.
 *
 * Ruled-line detection lives in this module too (see below); borderless
 * alignment detection is still open in
 * TASKS/0045-detect-pdf-tables-and-emit-table-node.md.
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

/**
 * Ruled-line table detection.
 *
 * A ruled table states its grid geometrically: stroked lines that close every
 * cell. This module turns a page's straight strokes into boundaries, and only
 * accepts a lattice whose every cell is closed on all four sides, so a single
 * underline, a boxed quote, or a decorative frame cannot become a table.
 * Merged ruled cells are out of scope for this slice: a span that straddles an
 * interior rule rejects the grid rather than being guessed into one cell.
 */

/** A straight stroked line in page-relative coordinates. */
export interface RuledStroke {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
}

/** The box of a retained text span, in the same page-relative space. */
export interface RuledSpanBox {
  readonly id: string;
  readonly x: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Span text; whitespace-only spans are not table content. */
  readonly text?: string;
}

export interface RuledTableCell {
  /** Grid position as `row:column`. */
  readonly key: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly spanIds: readonly string[];
}

export interface RuledTable {
  readonly id: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly x: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly RuledTableCell[];
}

export interface RuledTableDiscovery {
  readonly tables: readonly RuledTable[];
  /** Grid-shaped rule sets that could not be read as a table. */
  readonly unresolved: number;
  /** The stroke budget stopped detection early, so rules may be missing. */
  readonly truncated: boolean;
}

export interface RuledTableLimits {
  readonly maxTablesPerPage: number;
  readonly maxRowsPerTable: number;
  readonly maxColumnsPerTable: number;
  readonly maxStrokes: number;
  /** Coordinates this close count as the same rule or boundary. */
  readonly tolerance: number;
  /** A stroke thicker than this is a block, not a rule. */
  readonly maxRuleWidth: number;
  /** Shortest stroke that can be a rule; shorter marks are dots and dashes. */
  readonly minRuleLength: number;
  /** A cell narrower or shorter than this is noise, so its rules merge. */
  readonly minCellSize: number;
  /** How much of a cell edge a rule may miss and still close the cell. */
  readonly maxEdgeGap: number;
  /** Fraction of cells that must hold text for rules to be a table. */
  readonly minTextCoverage: number;
}

export const DEFAULT_RULED_TABLE_LIMITS: RuledTableLimits = {
  maxTablesPerPage: 16,
  maxRowsPerTable: 500,
  maxColumnsPerTable: 64,
  maxStrokes: 4_000,
  tolerance: 0.004,
  maxRuleWidth: 0.02,
  minRuleLength: 0.02,
  minCellSize: 0.02,
  maxEdgeGap: 0.01,
  minTextCoverage: 0.5,
};

interface Rule {
  /** Position across the page: y for a horizontal rule, x for a vertical one. */
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly thickness: number;
}

const finite = (...values: readonly number[]): boolean =>
  values.every((value) => Number.isFinite(value));

/** Merge rules that sit on the same line into one boundary. */
function clusterRules(
  rules: readonly Rule[],
  limits: RuledTableLimits,
): Rule[] {
  const clusters: Rule[] = [];
  for (const rule of [...rules].sort(
    (left, right) => left.position - right.position,
  )) {
    const last = clusters.at(-1);
    const gap = rule.position - (last?.position ?? Number.POSITIVE_INFINITY);
    if (
      last &&
      gap <= Math.max(limits.tolerance, last.thickness, rule.thickness)
    ) {
      const thickness = Math.max(last.thickness, rule.thickness);
      const count = (last as Rule & { count?: number }).count ?? 1;
      clusters[clusters.length - 1] = {
        position: (last.position * count + rule.position) / (count + 1),
        start: Math.min(last.start, rule.start),
        end: Math.max(last.end, rule.end),
        thickness,
      };
      (clusters[clusters.length - 1] as Rule & { count?: number }).count =
        count + 1;
      continue;
    }
    clusters.push({ ...rule });
    (clusters[clusters.length - 1] as Rule & { count?: number }).count = 1;
  }
  return clusters;
}

/** Drop boundaries that are too close to be a real cell side. */
function dedupePositions(
  positions: readonly number[],
  minimum: number,
): number[] {
  const kept: number[] = [];
  for (const position of [...positions].sort((left, right) => left - right))
    if (position - (kept.at(-1) ?? Number.NEGATIVE_INFINITY) >= minimum)
      kept.push(position);
  return kept;
}

interface RuleGroup {
  readonly horizontal: Rule[];
  readonly vertical: Rule[];
}

/**
 * Split strokes into rule groups that touch each other. Rules of two separate
 * tables never touch, so each group is examined on its own and one broken grid
 * cannot spoil a healthy neighbour. Rules are only claimed once they are known
 * to cross, otherwise the first grid would swallow the rules of the next.
 */
function groupRules(
  strokes: readonly RuledStroke[],
  limits: RuledTableLimits,
): { groups: RuleGroup[]; truncated: boolean } {
  const horizontals: Rule[] = [];
  const verticals: Rule[] = [];
  let truncated = false;
  let seen = 0;
  for (const stroke of strokes) {
    if (seen >= limits.maxStrokes) {
      truncated = true;
      break;
    }
    seen += 1;
    if (
      !finite(stroke.x1, stroke.y1, stroke.x2, stroke.y2, stroke.width) ||
      stroke.width > limits.maxRuleWidth
    )
      continue;
    const dx = Math.abs(stroke.x2 - stroke.x1);
    const dy = Math.abs(stroke.y2 - stroke.y1);
    const alignment = Math.max(limits.tolerance, stroke.width);
    if (dy <= alignment && dx >= limits.minRuleLength)
      horizontals.push({
        position: (stroke.y1 + stroke.y2) / 2,
        start: Math.min(stroke.x1, stroke.x2),
        end: Math.max(stroke.x1, stroke.x2),
        thickness: stroke.width,
      });
    else if (dx <= alignment && dy >= limits.minRuleLength)
      verticals.push({
        position: (stroke.x1 + stroke.x2) / 2,
        start: Math.min(stroke.y1, stroke.y2),
        end: Math.max(stroke.y1, stroke.y2),
        thickness: stroke.width,
      });
    // A diagonal stroke is decoration or a chart, never a cell border.
  }

  const order = (rules: readonly Rule[]) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .sort((left, right) => left.rule.position - right.rule.position);
  const byHorizontal = order(horizontals);
  const byVertical = order(verticals);
  // Only rules whose position falls inside the other's extent can cross, and
  // those are contiguous once sorted, so a binary search bounds the work.
  const firstAtOrAfter = (
    entries: readonly { rule: Rule; index: number }[],
    value: number,
  ): number => {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (entries[middle]!.rule.position < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const groups: RuleGroup[] = [];
  const horizontalOwner = new Map<number, number>();
  const verticalOwner = new Map<number, number>();
  for (const seed of byHorizontal) {
    if (horizontalOwner.has(seed.index)) continue;
    const groupId = groups.length;
    const group: { horizontal: Rule[]; vertical: Rule[] } = {
      horizontal: [],
      vertical: [],
    };
    groups.push(group);
    horizontalOwner.set(seed.index, groupId);
    const queue: Array<{ kind: 'h' | 'v'; index: number }> = [
      { kind: 'h', index: seed.index },
    ];
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) continue;
      if (entry.kind === 'h') {
        const rule = horizontals[entry.index]!;
        group.horizontal.push(rule);
        const gap = limits.tolerance;
        const from = firstAtOrAfter(byVertical, rule.start - gap);
        for (let cursor = from; cursor < byVertical.length; cursor++) {
          const candidate = byVertical[cursor]!;
          if (candidate.rule.position > rule.end + gap) break;
          if (verticalOwner.has(candidate.index)) continue;
          if (!reaches(candidate.rule, rule.position, gap)) continue;
          verticalOwner.set(candidate.index, groupId);
          queue.push({ kind: 'v', index: candidate.index });
        }
      } else {
        const rule = verticals[entry.index]!;
        group.vertical.push(rule);
        const gap = limits.tolerance;
        const from = firstAtOrAfter(byHorizontal, rule.start - gap);
        for (let cursor = from; cursor < byHorizontal.length; cursor++) {
          const candidate = byHorizontal[cursor]!;
          if (candidate.rule.position > rule.end + gap) break;
          if (horizontalOwner.has(candidate.index)) continue;
          if (!reaches(candidate.rule, rule.position, gap)) continue;
          horizontalOwner.set(candidate.index, groupId);
          queue.push({ kind: 'h', index: candidate.index });
        }
      }
    }
  }
  // Rules that touch nothing are ordinary rules, not a candidate table; they
  // are dropped here and never counted as unresolved.
  return {
    groups: groups.filter(
      (group) => group.horizontal.length > 0 && group.vertical.length > 0,
    ),
    truncated,
  };
}

/** Does a rule reach the perpendicular position of the rule crossing it? */
function reaches(rule: Rule, position: number, gap: number): boolean {
  const slack = Math.max(gap, rule.thickness, 0.002);
  return rule.start - slack <= position && rule.end + slack >= position;
}

interface Lattice {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly horizontal: readonly Rule[];
  readonly vertical: readonly Rule[];
}

function toLattice(
  group: RuleGroup,
  limits: RuledTableLimits,
): Lattice | undefined {
  const xs = dedupePositions(
    clusterRules(group.vertical, limits).map((rule) => rule.position),
    limits.minCellSize,
  );
  const ys = dedupePositions(
    clusterRules(group.horizontal, limits).map((rule) => rule.position),
    limits.minCellSize,
  );
  // Two of each means at least two rows and two columns of cells: a single
  // bordered box or a ruled-off heading is not a table.
  if (
    xs.length < 3 ||
    ys.length < 3 ||
    xs.length > limits.maxColumnsPerTable + 1 ||
    ys.length > limits.maxRowsPerTable + 1
  )
    return undefined;
  return {
    xs,
    ys,
    horizontal: clusterRules(group.horizontal, limits),
    vertical: clusterRules(group.vertical, limits),
  };
}

/** How much of `[from, to]` the rules at `position` actually cover. */
function coverage(
  rules: readonly Rule[],
  position: number,
  from: number,
  to: number,
  limits: RuledTableLimits,
): number {
  let covered = 0;
  for (const rule of rules) {
    if (
      Math.abs(rule.position - position) >
      Math.max(limits.tolerance, rule.thickness)
    )
      continue;
    covered += Math.max(0, Math.min(rule.end, to) - Math.max(rule.start, from));
  }
  return Math.min(covered, to - from);
}

function closesAt(
  rules: readonly Rule[],
  position: number,
  from: number,
  to: number,
  limits: RuledTableLimits,
): boolean {
  return (
    coverage(rules, position, from, to, limits) >= to - from - limits.maxEdgeGap
  );
}

/** Every cell must be closed on all four sides, or the grid is not a grid. */
function isClosedGrid(lattice: Lattice, limits: RuledTableLimits): boolean {
  for (let row = 0; row < lattice.ys.length - 1; row++)
    for (let column = 0; column < lattice.xs.length - 1; column++) {
      const left = lattice.xs[column]!;
      const right = lattice.xs[column + 1]!;
      const top = lattice.ys[row]!;
      const bottom = lattice.ys[row + 1]!;
      if (
        right - left < limits.minCellSize ||
        bottom - top < limits.minCellSize
      )
        return false;
      if (
        !closesAt(lattice.horizontal, top, left, right, limits) ||
        !closesAt(lattice.horizontal, bottom, left, right, limits) ||
        !closesAt(lattice.vertical, left, top, bottom, limits) ||
        !closesAt(lattice.vertical, right, top, bottom, limits)
      )
        return false;
    }
  return true;
}

/**
 * Give each text span to the single cell it lies in. A span that overlaps two
 * cells straddles a rule, which is a merged cell this slice does not read, so
 * the whole grid is refused instead of silently dropping half the text.
 */
function assignSpans(
  spans: readonly RuledSpanBox[],
  lattice: Lattice,
  limits: RuledTableLimits,
): Map<string, string[]> | undefined {
  const cells = new Map<string, string[]>();
  let filled = 0;
  for (let row = 0; row < lattice.ys.length - 1; row++)
    for (let column = 0; column < lattice.xs.length - 1; column++)
      cells.set(`${row}:${column}`, []);
  for (const box of spans) {
    const overlaps: string[] = [];
    for (let row = 0; row < lattice.ys.length - 1; row++)
      for (let column = 0; column < lattice.xs.length - 1; column++) {
        const horizontal =
          Math.min(box.x + box.width, lattice.xs[column + 1]!) -
          Math.max(box.x, lattice.xs[column]!);
        const vertical =
          Math.min(box.top + box.height, lattice.ys[row + 1]!) -
          Math.max(box.top, lattice.ys[row]!);
        if (horizontal > limits.tolerance && vertical > limits.tolerance)
          overlaps.push(`${row}:${column}`);
      }
    if (overlaps.length === 0) continue; // caption, running head, other prose
    if (overlaps.length > 1) return undefined;
    const [key] = overlaps;
    const bucket = cells.get(key!);
    if (!bucket) return undefined;
    if (bucket.length === 0) filled += 1;
    bucket.push(box.id);
  }
  const total = (lattice.ys.length - 1) * (lattice.xs.length - 1);
  if (total === 0 || filled / total < limits.minTextCoverage) return undefined;
  return cells;
}

/**
 * Find ruled tables among a page's straight strokes. Text outside the grid is
 * left to the paragraph path, and a grid that cannot be closed or completed
 * keeps all of its text as paragraphs.
 */
export function detectRuledTables(
  spans: readonly RuledSpanBox[],
  strokes: readonly RuledStroke[],
  limits: RuledTableLimits = DEFAULT_RULED_TABLE_LIMITS,
): RuledTableDiscovery {
  const tables: RuledTable[] = [];
  let unresolved = 0;
  if (strokes.length === 0 || limits.maxTablesPerPage <= 0)
    return { tables, unresolved, truncated: false };
  const usable = spans.filter(
    (box) =>
      (box.text ?? '').trim().length > 0 &&
      finite(box.x, box.top, box.width, box.height),
  );
  const { groups, truncated } = groupRules(strokes, limits);
  interface Candidate {
    readonly lattice: Lattice;
    readonly assignment: Map<string, string[]>;
  }
  const candidates: Candidate[] = [];
  for (const group of groups) {
    const lattice = toLattice(group, limits);
    if (!lattice) continue; // ordinary rules, not a table-shaped rule set
    if (!isClosedGrid(lattice, limits)) {
      unresolved += 1;
      continue;
    }
    const assignment = assignSpans(usable, lattice, limits);
    if (!assignment) {
      unresolved += 1;
      continue;
    }
    candidates.push({ lattice, assignment });
  }
  // Two grids that both contain one span are pathological; refusing them both
  // keeps every word on the paragraph path instead of printing it twice.
  const owners = new Map<string, number>();
  const shared = new Set<number>();
  candidates.forEach((candidate, index) => {
    for (const ids of candidate.assignment.values())
      for (const id of ids) {
        const previous = owners.get(id);
        if (previous === undefined) owners.set(id, index);
        else if (previous !== index) shared.add(previous).add(index);
      }
  });
  candidates.forEach((candidate, index) => {
    if (tables.length >= limits.maxTablesPerPage) return;
    if (shared.has(index)) {
      unresolved += 1;
      return;
    }
    const { lattice } = candidate;
    const cells: RuledTableCell[] = [];
    for (let row = 0; row < lattice.ys.length - 1; row++)
      for (let column = 0; column < lattice.xs.length - 1; column++) {
        const key = `${row}:${column}`;
        cells.push({
          key,
          rowIndex: row,
          columnIndex: column,
          spanIds: candidate.assignment.get(key) ?? [],
        });
      }
    const top = lattice.ys[0]!;
    const left = lattice.xs[0]!;
    tables.push({
      id: `ruled-table-${tables.length}`,
      rowCount: lattice.ys.length - 1,
      columnCount: lattice.xs.length - 1,
      x: left,
      top,
      width: lattice.xs.at(-1)! - left,
      height: lattice.ys.at(-1)! - top,
      cells,
    });
  });
  return { tables, unresolved, truncated };
}
