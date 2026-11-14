import { createRequire } from "node:module";

interface PackageMetadata {
  name: string;
  version: string;
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function loadPackageMetadata(): Readonly<PackageMetadata> {
  const require = createRequire(import.meta.url);
  let rawMetadata: unknown;

  try {
    rawMetadata = require("../package.json");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read package metadata: ${detail}`);
  }

  if (typeof rawMetadata !== "object" || rawMetadata === null) {
    throw new Error("Invalid package metadata: expected an object");
  }

  const metadata = rawMetadata as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    throw new Error("Invalid package metadata: name must be a non-empty string");
  }
  if (
    typeof metadata.version !== "string" ||
    !semverPattern.test(metadata.version)
  ) {
    throw new Error("Invalid package metadata: version must be valid SemVer");
  }

  return Object.freeze({
    name: metadata.name,
    version: metadata.version,
  });
}

export const packageMetadata = loadPackageMetadata();
