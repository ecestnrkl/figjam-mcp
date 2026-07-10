import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageLockUrl = new URL("../package-lock.json", import.meta.url);
const entryPointUrl = new URL("../dist/index.js", import.meta.url);
const serverUrl = new URL("../dist/server.js", import.meta.url);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const packageLock = JSON.parse(await readFile(packageLockUrl, "utf8"));
const expectedPublishedFiles = new Set([
  "dist",
  "README.md",
  ".env.example",
  "docs/pipeline.gif",
]);
const publishedFiles = Array.isArray(packageJson.files)
  ? packageJson.files
  : [];
const normalizedPublishedFiles = publishedFiles
  .filter((entry) => typeof entry === "string")
  .map((entry) => entry.replace(/\/$/, ""));

invariant(
  packageJson.main === "dist/index.js",
  "package.json main must point to dist/index.js",
);
invariant(
  packageJson.types === "dist/index.d.ts",
  "package.json types must point to dist/index.d.ts",
);
invariant(
  packageJson.bin?.[packageJson.name] === "dist/index.js",
  "package.json bin must expose dist/index.js under the package name",
);
invariant(
  normalizedPublishedFiles.length === publishedFiles.length &&
    normalizedPublishedFiles.length === expectedPublishedFiles.size &&
    new Set(normalizedPublishedFiles).size === expectedPublishedFiles.size &&
    normalizedPublishedFiles.every((entry) =>
      expectedPublishedFiles.has(entry),
    ),
  "package.json files must contain only the documented runtime files",
);
invariant(
  packageLock.version === packageJson.version &&
    packageLock.packages?.[""]?.version === packageJson.version,
  "package-lock.json version must match package.json",
);

await access(serverUrl, constants.R_OK);
const source = await readFile(entryPointUrl, "utf8");
invariant(
  source.startsWith("#!/usr/bin/env node\n"),
  "dist/index.js is missing the Node.js shebang",
);

if (process.platform !== "win32") {
  await access(entryPointUrl, constants.X_OK);
  const entryPointStat = await stat(entryPointUrl);
  invariant(
    (entryPointStat.mode & 0o111) !== 0,
    "dist/index.js is not executable",
  );
}

console.log(
  `Package metadata and executable verified for ${packageJson.name}@${packageJson.version}`,
);
