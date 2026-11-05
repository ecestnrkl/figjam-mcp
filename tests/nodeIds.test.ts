import { describe, expect, it } from "vitest";
import { assertLinksOfBoard, conversionNotice, nodeIdFromLinkForm, resolveNodeIds } from "../src/lib/nodeIds.js";

const link = (query: string, key = "AbC123", kind = "board") => `https://www.figma.com/${kind}/${key}/Example?${query}`;
const resolve = (ids: string[], known: string[] = ["5:87", "I5:87;1:2", "6:1"]) =>
  resolveNodeIds(ids, "AbC123", "nodeIds", "boardId", (id) => known.includes(id));

describe("node IDs in link form", () => {
  it.each([
    ["5-87", "5:87"],
    ["5%3A87", "5:87"],
    ["5%3a87", "5:87"],
    ["I5-87%3B1-2", "I5:87;1:2"],
    ["I5%3A87%3B1%3A2", "I5:87;1:2"],
    ["5:87", "5:87"],
    ["100%", "100%"],
  ])("reads %s as %s", (value, id) => expect(nodeIdFromLinkForm(value)).toBe(id));

  it.each([
    ["5-87", "5:87", [["5-87", "5:87"]]],
    ["5%3A87", "5:87", [["5%3A87", "5:87"]]],
    ["I5-87%3B1-2", "I5:87;1:2", [["I5-87%3B1-2", "I5:87;1:2"]]],
    [link("node-id=5-87&t=AbCdEf-0"), "5:87", [["5-87", "5:87"]]],
    [link("t=AbCdEf-0&node-id=5%3A87", "AbC123", "design"), "5:87", []],
    [link("node-id=I5-87%3B1-2"), "I5:87;1:2", [["I5-87;1-2", "I5:87;1:2"]]],
    ["5:87", "5:87", []],
  ] as Array<[string, string, Array<[string, string]>]>)("resolves %s to %s", (value, id, conversions) => {
    const resolved = resolve([value]);
    expect(resolved.ids).toEqual([id]);
    expect(resolved.conversions).toEqual(conversions);
  });

  it("leaves an ID that exists in the snapshot unchanged, even with a dash", () => {
    expect(resolve(["5-87"], ["5-87"])).toEqual({ ids: ["5-87"], conversions: [] });
    expect(resolve(["I5-87%3B1-2"], ["I5-87%3B1-2"])).toEqual({ ids: ["I5-87%3B1-2"], conversions: [] });
  });

  it("keeps request order, drops duplicates and names each conversion once", () => {
    const resolved = resolve(["6:1", "5-87", "5%3A87", "5:87", "5-87"]);
    expect(resolved.ids).toEqual(["6:1", "5:87"]);
    expect(resolved.conversions).toEqual([["5-87", "5:87"], ["5%3A87", "5:87"]]);
  });

  it("reads an ID it cannot find in link form all the same", () => {
    expect(resolve(["9-9"]).ids).toEqual(["9:9"]);
  });

  it("names a conversion once, in a sentence", () => {
    expect(conversionNotice([])).toBeUndefined();
    expect(conversionNotice([["5-87", "5:87"]])).toBe("Read 5-87 as 5:87.");
    expect(conversionNotice([["5-87", "5:87"], ["6-1", "6:1"]])).toBe("Read 5-87 as 5:87, 6-1 as 6:1.");
    expect(conversionNotice(Array.from({ length: 8 }, (_, index) => [`${index}-1`, `${index}:1`] as [string, string])))
      .toBe("Read 0-1 as 0:1, 1-1 as 1:1, 2-1 as 2:1, 3-1 as 3:1, 4-1 as 4:1 and 3 more.");
  });

  it.each([
    [link("node-id=5-87", "Other456")],
    [link("node-id=5-87", "Other456", "design")],
  ])("rejects the link %s of another board, naming both file keys", (value) => {
    expect(() => resolve([value])).toThrow("A Figma link in nodeIds belongs to board Other456, but boardId is board AbC123.");
    expect(() => assertLinksOfBoard([value], "AbC123", "focusNodeIds", "figmaFileUrl"))
      .toThrow("A Figma link in focusNodeIds belongs to board Other456, but figmaFileUrl is board AbC123.");
  });

  it("rejects a link of the board without a node-id", () => {
    expect(() => resolve([link("t=abc")])).toThrow("A Figma link in nodeIds must carry a node-id");
  });
});
