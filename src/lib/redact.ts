import { readBoolEnv } from "./env.js";
import { tableCellPositions } from "./tableCells.js";
import type { BoardData, NormalizedNode, TableCell } from "../types.js";

export const REDACTED = "[redacted]";

// Bare "token" and "secret" are common design labels, so they stay untouched.
const SPACE = String.raw`[^\S\r\n]`;
const SEPARATOR = String.raw`(?:[^\S\r\n]|[_-])?`;
const EXTENDABLE_LABELS = String.raw`pass(?:wor[dt]|code)|kennwort|api${SEPARATOR}key|(?:access|auth|bearer)${SEPARATOR}token|client${SEPARATOR}secret|(?:secret|access|private)${SEPARATOR}key`;
const DIRECT_LABELS = String.raw`pwd?|api${SEPARATOR}token|pin[ -]code|zugangscode`;
const LABEL_SUFFIX = String.raw`(?:${SPACE}+(?:for|für|zum|zur|of|von)${SPACE}+[^:=\r\n]{1,40}|${SPACE}*\([^()\r\n]+\))?`;
const VALUE_LABELS = String.raw`(?:${EXTENDABLE_LABELS})${LABEL_SUFFIX}|${DIRECT_LABELS}|pin(?=${SPACE}*[:=]${SPACE}*\d)`;
// Underscores delimit labels too (for example aws_secret_access_key).
const LABELED_VALUE = new RegExp(String.raw`(?<![\p{L}\p{N}])((?:${VALUE_LABELS})${SPACE}*[:=]${SPACE}*)(?!\[redacted\])(?=\S)[^\r\n]*`, "giu");
const EMPTY_LABEL = new RegExp(String.raw`(?<![\p{L}\p{N}])((?:${EXTENDABLE_LABELS})${LABEL_SUFFIX}|${DIRECT_LABELS}|pin)${SPACE}*[:=]${SPACE}*$`, "iu");
const TABLE_LABEL = new RegExp(String.raw`^(?:${EXTENDABLE_LABELS}|${DIRECT_LABELS}|pin)${SPACE}*:?$`, "iu");
const BEARER_TOKEN = /\b(Bearer[ \t]+)[A-Za-z0-9._~+/-]{20,}=*/gi;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
// Error messages retain the established rules: board-only labels must not consume
// actionable configuration names such as FIGMA_ACCESS_TOKEN followed by a colon.
const MESSAGE_LABELS = String.raw`pass(?:wor[dt]|code)|kennwort|pwd?|pin|api[\s_-]?(?:key|token)|(?:access|auth|bearer)[\s_-]?token|client[\s_-]?secret|(?:secret|access|private)[\s_-]?key`;
const MESSAGE_LABELED_VALUE = new RegExp(String.raw`(?<![\p{L}\p{N}_])((?:${MESSAGE_LABELS})[^\S\r\n]*[:=][^\S\r\n]*)(?=\S)[^\r\n]*`, "giu");
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi;
const KEY_FORMATS = [
  /(?<![A-Za-z0-9_])(?:gh[pous]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])figd_[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g,
];

const redactedBoards = new WeakMap<BoardData, BoardData>();

export function isCredentialRedactionEnabled(): boolean {
  return readBoolEnv("FIGJAM_MCP_REDACT_CREDENTIALS", true);
}

/** Redacts explicit credential values, preserving already-redacted summaries. */
export function redactCredentials(text: string): string {
  if (!text || !isCredentialRedactionEnabled()) return text;
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  // Keep line separators and indentation while checking the next non-empty line.
  const lines = result.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const label = EMPTY_LABEL.exec(lines[i]!);
    if (!label) continue;
    let next = i + 2;
    while (next < lines.length && !lines[next]!.trim()) next += 2;
    if (next >= lines.length) continue;
    const value = lines[next]!.trim();
    if (!/^\S{4,}$/u.test(value) || value.startsWith(REDACTED) || (label[1]!.toLowerCase() === "pin" && !/^\d/.test(value))) continue;
    lines[next] = lines[next]!.replace(value, REDACTED);
  }
  result = lines.join("").replace(LABELED_VALUE, `$1${REDACTED}`);
  result = result.replace(BEARER_TOKEN, `$1${REDACTED}`).replace(JWT, REDACTED);
  for (const pattern of KEY_FORMATS) result = result.replace(pattern, REDACTED);
  return result;
}

/** Preserve the pre-existing credential filtering at external error boundaries. */
export function redactMessageCredentials(text: string): string {
  if (!text || !isCredentialRedactionEnabled()) return text;
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const pattern of KEY_FORMATS) result = result.replace(pattern, REDACTED);
  return result.replace(MESSAGE_LABELED_VALUE, `$1${REDACTED}`);
}

/** Table context identifies credentials even when a value has no inline label. */
export function redactTableCells(cells: TableCell[], tableId?: string): TableCell[] {
  if (!isCredentialRedactionEnabled()) return cells;
  const positioned = tableId === undefined ? cells : tableCellPositions({ id: tableId, table: { cells } });
  const secretColumns = new Set(positioned.filter((cell) => cell.row === 0 && cell.column !== undefined && cell.column >= 1 && TABLE_LABEL.test(cell.text.trim())).map((cell) => cell.column));
  const secretRows = new Set(positioned.filter((cell) => cell.column === 0 && TABLE_LABEL.test(cell.text.trim())).map((cell) => cell.row));
  return cells.map((original, index) => {
    const cell = positioned[index]!;
    const secret = (cell.row !== undefined && cell.row > 0 && cell.column !== undefined && secretColumns.has(cell.column)) ||
      (cell.column !== undefined && cell.column > 0 && cell.row !== undefined && secretRows.has(cell.row));
    return { ...original, text: secret && !cell.text.startsWith(REDACTED) ? REDACTED : redactCredentials(cell.text) };
  });
}

/** Applies extraction redaction to node names, text and table cells of stored nodes. */
export function redactNodes(nodes: NormalizedNode[]): NormalizedNode[] {
  if (!isCredentialRedactionEnabled()) return nodes;
  return nodes.map((node) => {
    const cells = node.table && redactTableCells(node.table.cells, node.id);
    let text = node.text;
    // Extraction appends the non-empty cells after optional table-level text.
    // Replace that known suffix, so short credentials cannot alter public text.
    if (text !== undefined && cells) {
      const original = node.table!.cells.map((cell) => cell.text).filter(Boolean).join("\n");
      const redacted = cells.map((cell) => cell.text).filter(Boolean).join("\n");
      if (text === original) text = redacted;
      else if (original && text.endsWith(`\n${original}`)) text = text.slice(0, -original.length) + redacted;
    }
    return {
      ...node,
      name: redactCredentials(node.name),
      ...(text === undefined ? {} : { text: redactCredentials(text) }),
      ...(cells ? { table: { cells } } : {}),
    };
  });
}

/**
 * Redacted view of a stored board, so snapshots cached before redaction existed
 * never reach a prompt or tool output unredacted. Memoized per board object so
 * evidence indexes stay cached.
 */
export function redactBoard(board: BoardData): BoardData {
  if (!isCredentialRedactionEnabled()) return board;
  const existing = redactedBoards.get(board);
  if (existing) return existing;
  const redacted: BoardData = {
    ...board,
    nodes: redactNodes(board.nodes),
    clusters: board.clusters.map((cluster) => ({
      ...cluster, label: redactCredentials(cluster.label), summary: redactCredentials(cluster.summary),
    })),
    connectorEdges: board.connectorEdges?.map((edge) => ({
      ...edge, ...(edge.label === undefined ? {} : { label: redactCredentials(edge.label) }),
    })),
    clusterRelations: board.clusterRelations?.map((relation) => ({
      ...relation, labels: relation.labels.map(redactCredentials),
    })),
  };
  redactedBoards.set(board, redacted);
  return redacted;
}
