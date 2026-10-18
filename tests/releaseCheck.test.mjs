import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { changelogSection, checkReleaseVersions } from "../scripts/release-check.mjs";

const server = version => ({ version, packages: [{ version }] });

it("accepts a tag that matches package.json and both server.json versions", () => {
  expect(checkReleaseVersions("v1.2.3", { version: "1.2.3" }, server("1.2.3"))).toBe("1.2.3");
});

it("names every file whose version differs from the tag", () => {
  expect(() => checkReleaseVersions("v1.2.3", { version: "1.2.2" }, { version: "1.2.3", packages: [{ version: "1.2.1" }] }))
    .toThrow("Tag v1.2.3 does not match package.json version (1.2.2), server.json packages[0].version (1.2.1)");
  expect(() => checkReleaseVersions("1.2.3", { version: "1.2.3" }, server("1.2.3"))).toThrow(/not of the form/);
  expect(() => checkReleaseVersions("v1.2.3-rc.1", { version: "1.2.3-rc.1" }, server("1.2.3-rc.1"))).toThrow(/not of the form/);
});

it("returns only the released CHANGELOG section of the version", () => {
  const changelog = "# Changelog\n\n## 1.2.4 — Unreleased\n\n- Next\n\n## 1.2.3 — 2026-10-20\n\n- Fixed a thing.\n- Added another.\n\n## 1.2.2 — 2026-10-01\n\n- Old\n";
  expect(changelogSection(changelog, "1.2.3")).toBe("- Fixed a thing.\n- Added another.\n");
  expect(() => changelogSection(changelog, "1.2.4")).toThrow(/still marks 1.2.4 as unreleased/);
  expect(() => changelogSection(changelog, "1.2.30")).toThrow(/no section for 1.2.30/);
  expect(() => changelogSection("## 1.2.3 — 2026-10-20\n\n", "1.2.3")).toThrow(/is empty/);
});

it("checks the repository files from the command line", async () => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = spawnSync(process.execPath, ["scripts/release-check.mjs", "v0.0.0-invalid"], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("not of the form");
  const mismatch = spawnSync(process.execPath, ["scripts/release-check.mjs", `v${version}`.replace(/\d+$/, patch => String(Number(patch) + 1))], { encoding: "utf8" });
  expect(mismatch.status).not.toBe(0);
  expect(mismatch.stderr).toContain("does not match package.json version");
});
