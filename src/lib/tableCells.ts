import type { NormalizedNode, TableCell } from "../types.js";

/**
 * Cells with their row and column. Values recorded in the snapshot come first.
 * Otherwise, if every cell ID has the form T<table ID>;<row ID>;<column ID> and
 * together they form a complete rectangle, row and column are the positions of
 * the row and column IDs in order of first appearance; else both stay empty.
 */
export function tableCellPositions(table: Pick<NormalizedNode, "id" | "table">): TableCell[] {
  const cells = table.table?.cells ?? [];
  const prefix = `T${table.id};`;
  const rowIds = new Map<string, number>();
  const columnIds = new Map<string, number>();
  const pairs = new Set<string>();
  const derived: Array<{ row: number; column: number }> = [];
  for (const cell of cells) {
    const parts = cell.id.startsWith(prefix) ? cell.id.slice(prefix.length).split(";") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) break;
    const [rowId, columnId] = parts as [string, string];
    if (!rowIds.has(rowId)) rowIds.set(rowId, rowIds.size);
    if (!columnIds.has(columnId)) columnIds.set(columnId, columnIds.size);
    pairs.add(`${rowId};${columnId}`);
    derived.push({ row: rowIds.get(rowId)!, column: columnIds.get(columnId)! });
  }
  const rectangle = derived.length === cells.length && pairs.size === cells.length &&
    pairs.size === rowIds.size * columnIds.size;
  return cells.map((cell, index) => {
    const row = cell.row ?? (rectangle ? derived[index]!.row : undefined);
    const column = cell.column ?? (rectangle ? derived[index]!.column : undefined);
    return { ...cell, ...(row === undefined ? {} : { row }), ...(column === undefined ? {} : { column }) };
  });
}

