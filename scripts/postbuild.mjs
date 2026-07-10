import { chmod, readFile } from "node:fs/promises";

const entryPoint = new URL("../dist/index.js", import.meta.url);
const source = await readFile(entryPoint, "utf8");

if (!source.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("dist/index.js is missing the Node.js shebang");
}

await chmod(entryPoint, 0o755);
