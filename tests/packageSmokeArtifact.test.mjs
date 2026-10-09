import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSmokeOptions, requireNewArtifactDirectory, retainVerifiedArtifact } from "../scripts/package-smoke-artifact.mjs";

const failures = vi.hoisted(() => ({ link: false, unlink: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual,
    link: async (...arguments_) => {
      if (failures.link) throw new Error("Simulated artifact promotion failure");
      return actual.link(...arguments_);
    },
    unlink: async (...arguments_) => {
      if (failures.unlink) throw new Error("Simulated artifact staging cleanup failure");
      return actual.unlink(...arguments_);
    },
  };
});

let temporary;
afterEach(async () => {
  failures.link = false;
  failures.unlink = false;
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

async function newDestination() {
  temporary = await mkdtemp(join(tmpdir(), "figjam-smoke-artifact-"));
  return join(temporary, "candidate");
}

it("preserves the default and combines the artifact and long-check options in either order", () => {
  expect(parseSmokeOptions([])).toEqual({ longCheck: false, artifactDir: undefined });
  expect(parseSmokeOptions(["--long"])).toEqual({ longCheck: true, artifactDir: undefined });
  for (const arguments_ of [["--long", "--artifact-dir", "candidate"], ["--artifact-dir", "candidate", "--long"]]) {
    expect(parseSmokeOptions(arguments_)).toEqual({ longCheck: true, artifactDir: resolve("candidate") });
  }
});

it.each([
  ["--artifact-dir"],
  ["--artifact-dir", ""],
  ["--artifact-dir", "--long"],
  ["--artifact-dir", "a", "--artifact-dir", "b"],
  ["--unknown"],
])("rejects invalid arguments: %j", (...arguments_) => {
  expect(() => parseSmokeOptions(arguments_)).toThrow();
});

it("retains exactly the tested bytes with a matching SHA-256 manifest", async () => {
  const directory = await newDestination();
  await requireNewArtifactDirectory(directory);
  const bytes = Buffer.from([0, 255, 31, 139, 8, 0, 10, 13]);
  const name = "figjam-context-mcp-0.4.0.tgz";
  const expectedChecksum = createHash("sha256").update(bytes).digest("hex");
  const retained = await retainVerifiedArtifact(bytes, name, directory);
  expect(await readFile(retained.archivePath)).toEqual(bytes);
  expect(retained.checksum).toBe(expectedChecksum);
  expect(await readFile(retained.checksumPath, "utf8")).toBe(`${expectedChecksum}  ${name}\n`);
  expect((await readdir(directory)).sort()).toEqual(["SHA256SUMS", name]);
});

it("refuses an existing directory without modifying its previous candidate", async () => {
  const directory = await newDestination();
  await mkdir(directory);
  const previous = join(directory, "figjam-context-mcp-0.4.0.tgz");
  await writeFile(previous, "previous candidate");
  await expect(requireNewArtifactDirectory(directory)).rejects.toThrow("already exists");
  await expect(retainVerifiedArtifact(Buffer.from("replacement"), "figjam-context-mcp-0.4.0.tgz", directory)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(previous, "utf8")).toBe("previous candidate");
  expect(await readdir(directory)).toEqual(["figjam-context-mcp-0.4.0.tgz"]);
});

it.each(["link", "unlink"])("leaves no candidate or success manifest after a %s failure", async operation => {
  const directory = await newDestination();
  failures[operation] = true;
  await expect(retainVerifiedArtifact(Buffer.from("tested tarball"), "candidate.tgz", directory)).rejects.toThrow("Simulated artifact");
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
