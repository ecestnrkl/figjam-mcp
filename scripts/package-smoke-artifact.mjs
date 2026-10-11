import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export function parseSmokeOptions(arguments_) {
  let longCheck = false;
  let artifactDir;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--long") longCheck = true;
    else if (argument === "--artifact-dir") {
      assert.equal(artifactDir, undefined, "--artifact-dir may only be supplied once");
      const directory = arguments_[++index];
      assert(directory?.trim() && !directory.startsWith("-"), "--artifact-dir requires a directory");
      artifactDir = resolve(directory);
    } else assert.fail(`Unsupported option: ${argument}. Supported options: --long, --artifact-dir <directory>`);
  }
  return { longCheck, artifactDir };
}

export async function requireNewArtifactDirectory(directory) {
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Artifact directory already exists; use a new directory: ${directory}`);
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// The caller supplies the exact tested tarball bytes only after every check and
// temporary-directory cleanup succeeds. A fresh destination protects earlier
// candidates; the .tgz becomes visible only after its staged bytes are verified.
export async function retainVerifiedArtifact(bytes, archiveName, directory) {
  assert.equal(basename(archiveName), archiveName, "Artifact filename must not contain a path");
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(archiveName), "Expected an npm tarball filename");
  const checksum = sha256(bytes);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Deliberately exclusive, including concurrent runs.
  const staged = join(directory, ".candidate.tmp");
  const archivePath = join(directory, archiveName);
  const checksumPath = join(directory, "SHA256SUMS");
  let published = false;
  try {
    await writeFile(staged, bytes, { flag: "wx" });
    assert.equal(sha256(await readFile(staged)), checksum, "Retained tarball differs from the tested tarball");
    await writeFile(checksumPath, `${checksum}  ${archiveName}\n`, { flag: "wx" });
    // Unlike rename, link also refuses to overwrite an unexpected destination.
    await link(staged, archivePath);
    published = true;
    await unlink(staged);
    return { archivePath, checksumPath, checksum };
  } catch (error) {
    if (published) await rm(archivePath, { force: true });
    await rm(staged, { force: true });
    await rm(checksumPath, { force: true });
    await rmdir(directory);
    throw error;
  }
}
