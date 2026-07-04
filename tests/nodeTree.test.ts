import { describe, it, expect } from "vitest";
import { flattenNodeTree } from "../src/lib/nodeTree.js";

describe("flattenNodeTree", () => {
  it.todo("flattens a nested Figma document tree into NormalizedNode[]");

  it("throws until implemented", () => {
    expect(() => flattenNodeTree({})).toThrow();
  });
});
