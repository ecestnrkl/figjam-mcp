/**
 * node scripts/release-check.mjs <tag> [notes-file]
 * Fails unless the tag, package.json and server.json name the same version and
 * CHANGELOG.md has a released section for it. Prints the version and writes the
 * section to notes-file for the GitHub release.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkReleaseVersions(tag, packageJson, serverJson) {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) throw new Error(`Tag ${tag} is not of the form v<major>.<minor>.<patch>`);
  const found = [["package.json version", packageJson.version], ["server.json version", serverJson.version],
    ...(serverJson.packages ?? []).map((entry, index) => [`server.json packages[${index}].version`, entry.version])];
  const mismatches = found.filter(([, value]) => value !== version);
  if (mismatches.length) throw new Error(`Tag ${tag} does not match ${mismatches.map(([name, value]) => `${name} (${value})`).join(", ")}`);
  return version;
}

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  if (/unreleased/i.test(lines[start])) throw new Error(`CHANGELOG.md still marks ${version} as unreleased`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return `${notes}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, notesFile] = process.argv.slice(2);
  if (!tag) throw new Error("Usage: node scripts/release-check.mjs <tag> [notes-file]");
  const root = new URL("..", import.meta.url);
  const read = async name => readFile(new URL(name, root), "utf8");
  const version = checkReleaseVersions(tag, JSON.parse(await read("package.json")), JSON.parse(await read("server.json")));
  const notes = changelogSection(await read("CHANGELOG.md"), version);
  if (notesFile) await writeFile(notesFile, notes);
  console.log(version);
}
