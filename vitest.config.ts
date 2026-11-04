import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows runners need about twice the time of the slowest fixtures; the 5 s default failed there.
    testTimeout: 20_000,
  },
});
