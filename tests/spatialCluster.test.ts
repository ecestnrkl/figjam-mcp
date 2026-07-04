import { describe, it, expect } from "vitest";
import { geometricPreCluster } from "../src/lib/spatialCluster.js";

describe("geometricPreCluster", () => {
  it.todo("groups nearby nodes into clusters based on bounding-box proximity");

  it("throws until implemented", () => {
    expect(() => geometricPreCluster([])).toThrow();
  });
});
