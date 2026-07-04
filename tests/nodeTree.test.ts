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
    expect(sticky).toEqual({
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

  it("keeps TABLE nodes whole and drops their TABLE_CELL children", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain("1:10"); // the table itself
    expect(ids).not.toContain("T1:10;1:11;1:12"); // compound-id cells dropped
    expect(ids).not.toContain("T1:10;1:11;1:13");

    const table = nodes.find((n) => n.id === "1:10");
    expect(table).toMatchObject({ type: "TABLE", width: 300, height: 150 });
  });

  it("throws on input without a document node", () => {
    expect(() => flattenNodeTree({})).toThrow();
  });
});
