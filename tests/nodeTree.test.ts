import { describe, it, expect } from "vitest";
import { flattenNodeTree } from "../src/lib/nodeTree.js";

const sampleFigmaFile = {
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          {
            id: "1:2",
            name: "Sticky note",
            type: "STICKY",
            absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 80 },
            characters: "Hello",
          },
          {
            id: "1:3",
            name: "Group",
            type: "GROUP",
            absoluteBoundingBox: { x: 200, y: 20, width: 50, height: 50 },
            children: [
              {
                id: "1:4",
                name: "Sticky note 2",
                type: "STICKY",
                absoluteBoundingBox: { x: 205, y: 25, width: 40, height: 40 },
                characters: "World",
              },
            ],
          },
          {
            id: "1:5",
            name: "Rotated sticky",
            type: "STICKY",
            absoluteBoundingBox: { x: 400, y: 20, width: 120, height: 120 },
            rotation: 45,
            characters: "Tilted",
          },
          {
            id: "1:6",
            name: "Screenshot",
            type: "SHAPE_WITH_TEXT",
            absoluteBoundingBox: { x: 600, y: 20, width: 300, height: 200 },
            fills: [
              { type: "SOLID" },
              { type: "IMAGE", imageRef: "img-ref-abc123" },
            ],
          },
          {
            id: "1:7",
            name: "Empty frame",
            type: "FRAME",
            absoluteBoundingBox: { x: 1000, y: 20, width: 100, height: 100 },
          },
          {
            id: "1:8",
            name: "Empty section",
            type: "SECTION",
            absoluteBoundingBox: { x: 1200, y: 20, width: 400, height: 400 },
            children: [
              {
                id: "1:9",
                name: "Empty nested group",
                type: "GROUP",
                absoluteBoundingBox: { x: 1210, y: 30, width: 50, height: 50 },
              },
            ],
          },
          {
            id: "1:10",
            name: "Table",
            type: "TABLE",
            absoluteBoundingBox: { x: 1700, y: 20, width: 300, height: 150 },
            children: [
              {
                id: "T1:10;1:11;1:12",
                name: "Table cell",
                type: "TABLE_CELL",
                absoluteBoundingBox: { x: 1700, y: 20, width: 150, height: 75 },
                characters: "Row 1",
              },
              {
                id: "T1:10;1:11;1:13",
                name: "Table cell",
                type: "TABLE_CELL",
                absoluteBoundingBox: { x: 1850, y: 20, width: 150, height: 75 },
                characters: "Row 2",
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("flattenNodeTree", () => {
  it("flattens a nested Figma document tree into NormalizedNode[]", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    // canvas + sticky + group + nested sticky + rotated sticky + image shape
    // + table (kept whole, its cells dropped); the empty frame/section/group
    // are filtered out.
    expect(nodes).toHaveLength(7);

    const sticky = nodes.find((n) => n.id === "1:2");
    expect(sticky).toMatchObject({
      id: "1:2",
      name: "Sticky note",
      type: "STICKY",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      rotation: 0,
      imageRef: undefined,
      text: "Hello",
      parentId: "0:1",
      pageId: "0:1",
      renderNodeId: "1:2",
      sectionIds: [],
    });

    const nested = nodes.find((n) => n.id === "1:4");
    expect(nested?.parentId).toBe("1:3");
    expect(nested?.text).toBe("World");
  });

  it("extracts rotation as reported by the API (0 when absent)", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    expect(nodes.find((n) => n.id === "1:5")?.rotation).toBe(45);
    expect(nodes.find((n) => n.id === "1:2")?.rotation).toBe(0);
  });

  it("extracts the imageRef of image fills", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    expect(nodes.find((n) => n.id === "1:6")?.imageRef).toBe("img-ref-abc123");
    expect(nodes.find((n) => n.id === "1:2")?.imageRef).toBeUndefined();
  });

  it("drops empty structural nodes (frames/groups/sections without content)", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    const ids = nodes.map((n) => n.id);
    expect(ids).not.toContain("1:7"); // empty frame
    expect(ids).not.toContain("1:8"); // section with only an empty group
    expect(ids).not.toContain("1:9"); // the empty group itself
    expect(ids).toContain("1:3"); // group WITH contentful child stays
  });

  it("renders TABLE nodes atomically while retaining original cell evidence", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain("1:10"); // the table itself
    expect(ids).not.toContain("T1:10;1:11;1:12"); // compound-id cells dropped
    expect(ids).not.toContain("T1:10;1:11;1:13");

    const table = nodes.find((n) => n.id === "1:10");
    expect(table).toMatchObject({
      type: "TABLE", width: 300, height: 150, renderNodeId: "1:10", text: "Row 1\nRow 2",
      table: { cells: [
        { id: "T1:10;1:11;1:12", text: "Row 1" },
        { id: "T1:10;1:11;1:13", text: "Row 2" },
      ] },
    });
    expect(table?.table?.cells[0]?.row).toBeUndefined();
  });

  it("changes table fingerprints on cell edits and retains whitespace", () => {
    const original = structuredClone(sampleFigmaFile);
    const changed = structuredClone(sampleFigmaFile);
    Object.assign(changed.document.children[0]!.children[6]!.children![0]!, { characters: "  Budget 999\n" });
    const before = flattenNodeTree(original).find((node) => node.type === "TABLE")!;
    const after = flattenNodeTree(changed).find((node) => node.type === "TABLE")!;
    expect(after.contentFingerprint).not.toBe(before.contentFingerprint);
    expect(after.table?.cells[0]?.text).toBe("  Budget 999\n");
  });

  it("retains nested section ancestry and extracts nested table text", () => {
    const raw = { document: { id: "doc", name: "Document", type: "DOCUMENT", children: [{
      id: "page", name: "Page", type: "CANVAS", children: [{
        id: "section", name: "Research", type: "SECTION", children: [{
          id: "nested", name: "Budget", type: "SECTION", children: [{
            id: "table", name: "Table", type: "TABLE", children: [{
              id: "cell", name: "Cell", type: "TABLE_CELL", rowIndex: 2, columnIndex: 1,
              children: [{ id: "text", name: "Text", type: "TEXT", characters: " Exact value " }],
            }],
          }],
        }],
      }],
    }] } };
    const table = flattenNodeTree(raw).find((node) => node.id === "table")!;
    expect(table).toMatchObject({
      pageId: "page", sectionIds: ["section", "nested"], renderNodeId: "table",
      table: { cells: [{ id: "cell", text: " Exact value ", row: 2, column: 1 }] },
    });
  });

  it("invalidates visual changes but not position-only moves", () => {
    const raw = (x: number, color: number) => ({ document: { id: "doc", name: "Doc", type: "DOCUMENT", children: [{
      id: "shape", name: "Shape", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: color, g: 0, b: 0 } }],
      absoluteBoundingBox: { x, y: 0, width: 100, height: 100 },
    }] } });
    const before = flattenNodeTree(raw(0, 0))[0]!;
    expect(flattenNodeTree(raw(500, 0))[0]!.contentFingerprint).toBe(before.contentFingerprint);
    expect(flattenNodeTree(raw(0, 1))[0]!.contentFingerprint).not.toBe(before.contentFingerprint);
  });

  it("handles wide trees without argument spreads and rejects oversized input clearly", () => {
    const raw = (count: number) => ({ document: { id: "doc", name: "Doc", type: "DOCUMENT", children:
      Array.from({ length: count }, (_, index) => ({ id: String(index), name: "Text", type: "TEXT", characters: "Value" })),
    } });
    expect(flattenNodeTree(raw(15_000))).toHaveLength(15_000);
    expect(() => flattenNodeTree(raw(130_000))).toThrow(/100000-node limit/);
  });

  it("handles deep trees iteratively and rejects excessive ancestry explicitly", () => {
    const raw = (depth: number) => {
      let tree: unknown = { id: "leaf", name: "Text", type: "TEXT", characters: "Deep finding" };
      for (let i = 0; i < depth; i++) tree = { id: `group-${i}`, name: "Group", type: "GROUP", children: [tree] };
      return { document: { id: "doc", name: "Doc", type: "DOCUMENT", children: [tree] } };
    };
    expect(flattenNodeTree(raw(500))).toHaveLength(501);
    expect(() => flattenNodeTree(raw(1100))).toThrow(/1024-level nesting limit/);
  });

  it("rejects deeply nested metadata before the fingerprint serializer can overflow", () => {
    let metadata: unknown = { value: "leaf" };
    for (let i = 0; i < 5000; i++) metadata = { child: metadata };
    const raw = { document: { id: "doc", name: "Doc", type: "DOCUMENT", children: [
      { id: "shape", name: "Shape", type: "RECTANGLE", pluginData: metadata },
    ] } };
    expect(() => flattenNodeTree(raw)).toThrow(/metadata deeper than 64 levels/);
  });

  it.each([
    { x: NaN, y: 0, width: 100, height: 100 },
    { x: 0, y: Infinity, width: 100, height: 100 },
    { x: 0, y: 0, width: -1, height: -1 },
  ])("rejects invalid source geometry early: %j", (absoluteBoundingBox) => {
    const raw = { document: { id: "doc", name: "Doc", type: "DOCUMENT", children: [
      { id: "shape", name: "Shape", type: "RECTANGLE", absoluteBoundingBox },
    ] } };
    expect(() => flattenNodeTree(raw)).toThrow(/invalid geometry/);
  });

  it("throws on input without a document node", () => {
    expect(() => flattenNodeTree({})).toThrow();
  });
});
