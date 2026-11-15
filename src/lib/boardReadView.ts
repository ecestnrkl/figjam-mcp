import { createHash } from "node:crypto";
import type { BoardData, NormalizedNode } from "../types.js";
import { labelDeterministicClusters, refineClusterFromText } from "./clusterText.js";
import { REDACTED, redactBoard } from "./redact.js";
import { configuredSecrets } from "./secrets.js";

export interface SecretSpan { start: number; end: number }

/** Find complete secrets while there is still enough text to recognize them. */
export function findSecretSpans(text: string, secrets: readonly string[]): SecretSpan[] {
  let spans: SecretSpan[] = [];
  const append = (merged: SecretSpan[], start: number, end: number) => {
    const previous = merged.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  };
  for (const secret of secrets) {
    if (!secret.length || secret.length > text.length) continue;

    // KMP prefix lengths let mismatches and overlapping matches reuse work.
    const prefix = new Uint32Array(secret.length);
    for (let i = 1, matched = 0; i < secret.length; i++) {
      const unit = secret.charCodeAt(i);
      while (matched && unit !== secret.charCodeAt(matched)) matched = prefix[matched - 1]!;
      if (unit === secret.charCodeAt(matched)) matched++;
      prefix[i] = matched;
    }

    // Matches arrive in start order; merge them with the already sorted spans.
    const merged: SecretSpan[] = [];
    let next = 0;
    for (let i = 0, matched = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      while (matched && unit !== secret.charCodeAt(matched)) matched = prefix[matched - 1]!;
      if (unit === secret.charCodeAt(matched)) matched++;
      if (matched !== secret.length) continue;

      const end = i + 1;
      const start = end - matched;
      while (next < spans.length && spans[next]!.start <= start) {
        const span = spans[next++]!;
        append(merged, span.start, span.end);
      }
      append(merged, start, end);
      matched = prefix[matched - 1]!;
    }
    if (!merged.length) continue;
    for (; next < spans.length; next++) {
      const span = spans[next]!;
      append(merged, span.start, span.end);
    }
    spans = merged;
  }
  return spans;
}

/** Render any range of the source, including a range that straddles a secret. */
export function maskRange(text: string, spans: readonly SecretSpan[], start = 0, end = text.length, first = 0): string {
  let output = "";
  let pos = start;
  for (let i = first; i < spans.length; i++) {
    const span = spans[i]!;
    if (span.end <= pos) continue;
    if (span.start >= end) break;
    output += text.slice(pos, Math.max(pos, span.start)) + REDACTED;
    pos = Math.min(span.end, end);
  }
  return output + text.slice(pos, end);
}

// One immutable view per snapshot and active credential set. No plaintext credential
// is retained in the cache key, including a token scoped to an ingest call.
const views = new WeakMap<BoardData, { signature: string; board: BoardData }>();
const origins = new WeakMap<BoardData, BoardData>();

/** The original wording is used for snapshot and evidence identities only. */
export function boardIdentitySource(board: BoardData): BoardData {
  return origins.get(board) ?? board;
}

/** Project secrets out of board content before display, retrieval or excerpt assembly. */
export function readBoardView(stored: BoardData): BoardData {
  const source = redactBoard(stored);
  const secrets = configuredSecrets();
  if (!secrets.length) return source;
  const signature = createHash("sha256").update(JSON.stringify(secrets.sort())).digest("hex");
  const cached = views.get(source);
  if (cached?.signature === signature) return cached.board;

  const mask = (text: string): string => maskRange(text, findSecretSpans(text, secrets));
  const optional = (text: string | undefined) => text === undefined ? undefined : mask(text);
  let nodesChanged = false;
  const nodes = source.nodes.map((node) => {
    const spans = node.text === undefined ? [] : findSecretSpans(node.text, secrets);
    const text = node.text === undefined ? undefined : maskRange(node.text, spans);
    let name = mask(node.name);
    // Figma may copy the start of a sticky into its name. The name alone
    // can already have lost the end of a secret visible in the full text.
    if (spans.length && name === node.name && node.text) {
      const prefix = node.name.endsWith("…") ? node.name.slice(0, -1)
        : node.name.endsWith("...") ? node.name.slice(0, -3) : node.name;
      if (node.text.startsWith(prefix)) name = maskRange(node.text, spans, 0, prefix.length) + node.name.slice(prefix.length);
    }
    let cellsChanged = false;
    const cells = node.table?.cells.map((cell) => {
      const safe = mask(cell.text);
      if (safe === cell.text) return cell;
      cellsChanged = true;
      return { ...cell, text: safe };
    });
    if (name === node.name && text === node.text && !cellsChanged) return node;
    nodesChanged = true;
    return { ...node, name, text, ...(cellsChanged ? { table: { ...node.table, cells: cells! } } : {}) };
  });

  const members = (items: NormalizedNode[]) => {
    const byId = new Map(items.map((node) => [node.id, node]));
    return source.clusters.map((cluster) => cluster.nodeIds.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    }));
  };
  // Stored deterministic labels and summaries can be older, shortened copies of
  // original text. Rebuild those known copies from the safe nodes for display.
  const beforeMembers = nodesChanged ? members(source.nodes) : undefined;
  const afterMembers = nodesChanged ? members(nodes) : undefined;
  const beforeLabels = beforeMembers && labelDeterministicClusters(source.clusters, beforeMembers, source.nodes);
  const afterLabels = afterMembers && labelDeterministicClusters(source.clusters, afterMembers, nodes);
  let changed = nodesChanged;
  const clusters = source.clusters.map((cluster, index) => {
    let label = mask(cluster.label);
    let summary = mask(cluster.summary);
    const phase = optional(cluster.phase);
    if (cluster.summarySource === "deterministic" && !cluster.modelId && beforeLabels && afterLabels) {
      if (cluster.label === beforeLabels[index]!.label) label = afterLabels[index]!.label;
      const before = beforeMembers![index]!;
      const after = afterMembers![index]!;
      if (after.some((node, i) => node !== before[i]) && cluster.summary === refineClusterFromText(cluster, before).summary) {
        summary = refineClusterFromText(cluster, after).summary;
      }
    }
    if (label === cluster.label && summary === cluster.summary && phase === cluster.phase) return cluster;
    changed = true;
    return { ...cluster, label, summary, phase };
  });
  const connectorEdges = source.connectorEdges?.map((edge) => {
    const label = optional(edge.label);
    if (label === edge.label) return edge;
    changed = true;
    return { ...edge, label };
  });
  const clusterRelations = source.clusterRelations?.map((relation) => {
    const labels = relation.labels.map(mask);
    if (labels.every((label, i) => label === relation.labels[i])) return relation;
    changed = true;
    return { ...relation, labels };
  });
  const board = changed ? { ...source, nodes, clusters, connectorEdges, clusterRelations } : source;
  if (board !== source) origins.set(board, source);
  views.set(source, { signature, board });
  return board;
}
