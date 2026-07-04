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
        ],
      },
    ],
  },
};

describe("flattenNodeTree", () => {
  it("flattens a nested Figma document tree into NormalizedNode[]", () => {
    const nodes = flattenNodeTree(sampleFigmaFile);
    expect(nodes).toHaveLength(4);

    const sticky = nodes.find((n) => n.id === "1:2");
    expect(sticky).toEqual({
      id: "1:2",
      name: "Sticky note",
      type: "STICKY",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      text: "Hello",
      parentId: "0:1",
    });

    const nested = nodes.find((n) => n.id === "1:4");
    expect(nested?.parentId).toBe("1:3");
    expect(nested?.text).toBe("World");
  });

  it("throws on input without a document node", () => {
    expect(() => flattenNodeTree({})).toThrow();
  });
});
