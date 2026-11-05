import { parseFigmaUrl } from "../schemas/common.js";

/** Most conversions named in one sentence. */
const MAX_NAMED_CONVERSIONS = 5;

export interface ResolvedNodeIds {
  /** The IDs to look up, duplicates removed, in request order. */
  ids: string[];
  /** Raw ID → canonical ID, for each ID that was read in link form. */
  conversions: Array<[string, string]>;
}

/** "5-87", "5%3A87" and "I5-87%3B1-2" are the link forms of "5:87" and "I5:87;1:2". */
export function nodeIdFromLinkForm(value: string): string {
  let decoded = value;
  if (value.includes("%")) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = value;
    }
  }
  return decoded.replaceAll("-", ":");
}

const hasUrlScheme = (value: string) => /^https?:\/\//i.test(value.trim());

/**
 * Throws when an ID is a link to another file than `fileKey`. Needs no board, so it runs before
 * any request or cache read.
 */
export function assertLinksOfBoard(ids: readonly string[], fileKey: string, parameter: string, boardParameter: string): void {
  for (const id of ids) {
    if (!hasUrlScheme(id)) continue;
    const link = parseFigmaUrl(id);
    if (link && link.fileKey !== fileKey) {
      throw new Error(
        `A Figma link in ${parameter} belongs to board ${link.fileKey}, but ${boardParameter} is board ${fileKey}. ` +
          `Pass node IDs or links of board ${fileKey}.`,
      );
    }
    if (link && !link.nodeId) throw new Error(`A Figma link in ${parameter} must carry a node-id (…?node-id=5-87).`);
  }
}

/**
 * Reads node IDs as hosts and users send them. An ID that exists in the snapshot stays unchanged;
 * any other is read in link form, and a Figma link of the same board gives its node-id parameter.
 */
export function resolveNodeIds(
  requested: readonly string[],
  fileKey: string,
  parameter: string,
  boardParameter: string,
  isKnown: (id: string) => boolean,
): ResolvedNodeIds {
  assertLinksOfBoard(requested, fileKey, parameter, boardParameter);
  const ids: string[] = [];
  const conversions: Array<[string, string]> = [];
  for (const value of requested) {
    let id = value;
    if (!isKnown(id)) {
      let source = value;
      // assertLinksOfBoard has checked that a Figma link of this board carries a node-id.
      if (hasUrlScheme(value)) source = parseFigmaUrl(value)?.nodeId ?? value;
      id = isKnown(source) ? source : nodeIdFromLinkForm(source);
      if (id !== source && !conversions.some(([from]) => from === source)) conversions.push([source, id]);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, conversions };
}

/** "Read 5-87 as 5:87." — once per call, so the host learns the canonical form. */
export function conversionNotice(conversions: ReadonlyArray<[string, string]>): string | undefined {
  if (!conversions.length) return undefined;
  const named = conversions.slice(0, MAX_NAMED_CONVERSIONS).map(([from, to]) => `${from} as ${to}`);
  const more = conversions.length - named.length;
  return `Read ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}
