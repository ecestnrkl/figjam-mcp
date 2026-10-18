import { readBoolEnv } from "./env.js";
import type { BoardData } from "../types.js";

export const REDACTED = "[redacted]";

// A bare "token" or "secret" label is left alone: on design boards "Token:" usually names a design token.
const LABELS = String.raw`pass(?:wor[dt]|code)|kennwort|pwd?|pin|api[\s_-]?(?:key|token)|(?:access|auth|bearer)[\s_-]?token|client[\s_-]?secret|(?:secret|access|private)[\s_-]?key`;
const LABELED_VALUE = new RegExp(String.raw`(?<![\p{L}\p{N}_])((?:${LABELS})[^\S\r\n]*[:=][^\S\r\n]*)(?=\S)[^\r\n]*`, "giu");
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

/**
 * Replaces explicit credentials with "[redacted]": labelled values up to the end of
 * the line and well-known key formats anywhere. Idempotent; mentions without a value stay.
 */
export function redactCredentials(text: string): string {
  if (!text || !isCredentialRedactionEnabled()) return text;
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const pattern of KEY_FORMATS) result = result.replace(pattern, REDACTED);
  return result.replace(LABELED_VALUE, `$1${REDACTED}`);
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
    nodes: board.nodes.map((node) => ({
      ...node,
      name: redactCredentials(node.name),
      ...(node.text === undefined ? {} : { text: redactCredentials(node.text) }),
      ...(node.table ? { table: { cells: node.table.cells.map((cell) => ({ ...cell, text: redactCredentials(cell.text) })) } } : {}),
    })),
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
