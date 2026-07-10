import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "figjam-context-mcp-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${output}`,
    );
  }

  return result;
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  run(
    npmCommand,
    [
      "pack",
      "--json",
      "--cache",
      join(temporaryDirectory, "npm-cache"),
      "--pack-destination",
      temporaryDirectory,
    ],
    { cwd: packageRoot },
  );

  const archives = (await readdir(temporaryDirectory)).filter((file) =>
    file.endsWith(".tgz"),
  );
  invariant(archives.length === 1, "npm pack did not produce exactly one tarball");

  const archivePath = join(temporaryDirectory, archives[0]);
  const archiveListing = run("tar", ["-tzf", archivePath]).stdout
    .split("\n")
    .filter(Boolean);

  for (const requiredFile of [
    "package/package.json",
    "package/README.md",
    "package/.env.example",
    "package/docs/pipeline.gif",
    "package/dist/index.js",
    "package/dist/server.js",
  ]) {
    invariant(
      archiveListing.includes(requiredFile),
      `Packed tarball is missing ${requiredFile}`,
    );
  }

  for (const forbiddenPrefix of [
    "package/src/",
    "package/tests/",
    "package/scripts/",
    "package/.github/",
    "package/.cache/",
  ]) {
    invariant(
      !archiveListing.some((entry) => entry.startsWith(forbiddenPrefix)),
      `Packed tarball unexpectedly contains ${forbiddenPrefix}`,
    );
  }

  run("tar", ["-xzf", archivePath, "-C", temporaryDirectory]);
  const extractedPackage = join(temporaryDirectory, "package");
  await symlink(
    join(packageRoot, "node_modules"),
    join(extractedPackage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const binaryRelativePath = packageJson.bin?.[packageJson.name];
  invariant(
    typeof binaryRelativePath === "string",
    "package.json does not expose its named binary",
  );
  const binaryPath = join(extractedPackage, binaryRelativePath);

  let command = binaryPath;
  let args = ["--version"];
  if (process.platform === "win32") {
    command = process.execPath;
    args = [binaryPath, "--version"];
  } else {
    await access(binaryPath, constants.X_OK);
  }

  const versionResult = run(command, args, { cwd: extractedPackage });
  invariant(
    versionResult.stdout.trim() === packageJson.version,
    `Packed binary returned ${JSON.stringify(versionResult.stdout.trim())}; expected ${packageJson.version}`,
  );

  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : binaryPath,
    args: process.platform === "win32" ? [binaryPath] : [],
    cwd: extractedPackage,
    stderr: "pipe",
  });
  let serverErrors = "";
  transport.stderr?.on("data", (chunk) => {
    serverErrors += String(chunk);
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const expectedToolNames = [
      "answer_from_board",
      "diagnose_llm_config",
      "diff_board",
      "get_board_context",
      "ingest_board",
    ];
    invariant(
      JSON.stringify(toolNames) === JSON.stringify(expectedToolNames),
      `Packed MCP server exposed ${JSON.stringify(toolNames)}; expected ${JSON.stringify(expectedToolNames)}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Packed MCP initialize/tools-list smoke test failed: ${detail}` +
        (serverErrors ? `\nServer stderr:\n${serverErrors}` : ""),
    );
  } finally {
    await client.close();
  }

  console.log(
    `Packed binary ${basename(binaryPath)} reports ${packageJson.version}; tarball and MCP tools verified`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
