import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "figjam-context-mcp-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run package:smoke");
const longCheck = process.argv.includes("--long");
assert(process.argv.slice(2).every(argument => argument === "--long"), "Supported option: --long");

async function ingestWithProgress(client, arguments_, label) {
  const events = [];
  const result = await client.callTool({ name: "ingest_board", arguments: arguments_ }, {
    timeout: 180_000,
    maxTotalTimeout: 180_000,
    resetTimeoutOnProgress: false,
    onprogress: update => events.push(update),
  });
  assert(!result.isError, `${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(events.map(event => event.message), ["fetch", "extract", "cluster", "interpret", "persist", "complete"],
    `${label}: a final response must arrive after all ingest progress phases`);
  assert.deepEqual(events.map(event => event.progress), [0, 1, 2, 3, 4, 5]);
  assert(events.every(event => event.total === 5));
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 180_000, ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}
function npm(args, cwd) {
  return run(process.execPath, [npmCli, ...args, "--cache", join(temporary, "npm-cache")], { cwd });
}

try {
  npm(["pack", "--json", "--pack-destination", temporary], root);
  const archives = (await readdir(temporary)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "Expected one npm tarball");
  const archive = join(temporary, archives[0]);
  const listing = run("tar", ["-tzf", archive]).stdout.split(/\r?\n/).filter(Boolean);
  for (const file of ["package.json", "README.md", ".env.example", "LICENSE", "CHANGELOG.md", "SECURITY.md", "server.json", "docs/pipeline.gif", "dist/index.js", "dist/server.js"]) {
    assert(listing.includes(`package/${file}`), `Tarball is missing ${file}`);
  }
  for (const prefix of ["src/", "tests/", "scripts/", ".github/", ".cache/", "node_modules/"]) {
    assert(!listing.some(file => file.startsWith(`package/${prefix}`)), `Tarball contains ${prefix}`);
  }
  assert(!listing.includes("package/.env"), "Tarball contains private environment settings");

  // Install the exact artifact into an unrelated directory with production dependencies only.
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "package-smoke-consumer", private: true, type: "module" }));
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], consumer);
  const installed = join(consumer, "node_modules", metadata.name);
  const binary = join(installed, "dist", "index.js");
  const installedMetadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedMetadata.version, metadata.version);
  for (const devPackage of ["vitest", "typescript", "@modelcontextprotocol/client"]) {
    await assert.rejects(access(join(consumer, "node_modules", devPackage)), { code: "ENOENT" });
  }
  if (process.platform !== "win32") await access(binary, constants.X_OK);
  assert.equal(run(process.execPath, [binary, "--version"], { cwd: consumer }).stdout.trim(), metadata.version);
  // npm exec exercises the installed POSIX executable / Windows .cmd shim.
  await access(join(consumer, "node_modules", ".bin", process.platform === "win32" ? `${metadata.name}.cmd` : metadata.name));
  const shimVersion = run(process.execPath, [npmCli, "exec", "--offline", "--no", "--", metadata.name, "--version"], { cwd: consumer });
  assert.equal(shimVersion.stdout.trim(), metadata.version);

  const cache = join(temporary, "cache");
  const requestsFile = join(temporary, "fixture-requests.jsonl");
  const preload = join(temporary, "offline-provider.mjs");
  // Only replace the network boundary. Every tool, parser, provider SDK, cache
  // operation and stdio response runs from the installed production artifact.
  // Unexpected requests fail closed: no fixture can contact a real provider.
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    let fileReads = 0;
    let tableReads = 0;
    let longRenderPending = false;
    const record = kind => appendFileSync(process.env.SMOKE_REQUESTS_FILE, JSON.stringify({ kind }) + '\\n');
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      if (url.origin === 'https://api.figma.com') {
        const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
        assert.equal(headers.get('X-Figma-Token'), 'offline-figma-token');
        if (url.pathname === '/v1/files/DeniedBoard123') {
          record('figma_denied');
          return new Response(null, { status: 403 });
        }
        if (url.pathname === '/v1/files/SmokeBoard123/meta') {
          record('figma_metadata');
          return json({ file: { version: String(fileReads) } });
        }
        if (url.pathname === '/v1/files/SmokeBoard123') {
          record('figma_file');
          fileReads++;
          return json({ version: String(fileReads), lastModified: '2026-10-08T10:00:00Z', document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
              id: '0:1', name: 'Workshop', type: 'CANVAS', children: [{
                id: '1:1', name: 'Evidence', type: 'STICKY',
                characters: 'Workshop finding version ' + fileReads,
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 }
              }]
            }]
          } });
        }
        if (url.pathname === '/v1/files/TableBoard123/meta') {
          record('table_metadata');
          return json({ file: { version: String(tableReads + 1) } });
        }
        if (url.pathname === '/v1/files/TableBoard123') {
          record('table_file');
          tableReads++;
          assert(tableReads <= 2, 'Table fixture only has two revisions');
          return json({ version: String(tableReads), document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
              id: '0:1', name: 'Budget workshop', type: 'CANVAS', children: [{
                id: '2:1', name: 'Budget table', type: 'TABLE',
                absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 80 }, children: [
                  { id: 'T2:1;0;0', name: 'Category', type: 'TABLE_CELL', characters: 'Simulator', rowIndex: 0, columnIndex: 0 },
                  { id: 'T2:1;0;1', name: 'Budget', type: 'TABLE_CELL', characters: tableReads === 1 ? 'Budget 100' : 'Budget 999', rowIndex: 0, columnIndex: 1 }
                ]
              }]
            }]
          } });
        }
        if (/^\\/v1\\/files\\/LegacyBoard(?:20251125|20250618)$/.test(url.pathname) || url.pathname === '/v1/files/LongBoard123') {
          const isLong = url.pathname.endsWith('/LongBoard123');
          assert(!isLong || process.env.SMOKE_LONG_CHECK === '1', 'Long fixture must be explicitly enabled');
          record(isLong ? 'long_file' : 'legacy_file');
          return json({ version: '1', document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
              id: '0:1', name: 'Progress workshop', type: 'CANVAS', children: [{
                id: '3:1', name: 'Progress evidence', type: 'STICKY', characters: 'Original progress source evidence',
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 }
              }]
            }]
          } });
        }
        if (url.pathname === '/v1/images/LongBoard123') {
          assert.equal(process.env.SMOKE_LONG_CHECK, '1');
          record('long_render');
          assert.equal(url.searchParams.get('version'), '1');
          assert.equal(url.searchParams.get('ids'), '3:1');
          longRenderPending = true;
          return json({ images: { '3:1': 'https://offline-images.invalid/long.png' } });
        }
        if (url.pathname === '/v1/images/SmokeBoard123') {
          record('figma_render');
          assert.equal(url.searchParams.get('version'), '2');
          assert.equal(url.searchParams.get('ids'), '1:1');
          return json({ images: { '1:1': 'https://offline-images.invalid/evidence.png' } });
        }
      }
      if (url.href === 'https://offline-images.invalid/evidence.png' || url.href === 'https://offline-images.invalid/long.png') {
        record(url.pathname === '/long.png' ? 'long_image' : 'image_download');
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), { headers: { 'content-type': 'image/png' } });
      }
      if (url.href === 'https://offline-model.invalid/v1/chat/completions') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : await input.text());
        assert.equal(body.model, 'offline-test-model');
        const schema = body.response_format?.json_schema?.name;
        record(schema ?? 'missing_schema');
        let reply;
        if (schema === 'figjam_cluster_refinement') {
          if (longRenderPending) {
            longRenderPending = false;
            record('long_model_delay_started');
            await delay(65_000, undefined, { signal });
            signal?.throwIfAborted();
            record('long_model_delay_completed');
            reply = { label: 'Progress evidence', summary: 'Original progress source evidence', confirmedNodeIds: ['3:1'] };
          } else reply = { label: 'Workshop evidence', summary: 'Workshop finding version 2', confirmedNodeIds: ['1:1'] };
        } else if (schema === 'figjam_evidence_answer') {
          const evidenceId = body.messages.find(message => message.role === 'user')?.content.match(/\\[(ev_[a-f0-9]+)\\]/)?.[1];
          assert(evidenceId, 'Answer request must contain an original evidence ID');
          reply = { answer: 'Workshop finding version 2.', evidenceIds: [evidenceId] };
        } else if (schema === 'diagnose_text_json') reply = { result: 42 };
        else if (schema === 'diagnose_fast_text_json') reply = { result: 63 };
        else if (schema === 'diagnose_vision_json') reply = { dominantColor: 'blue' };
        else throw new Error('Unexpected offline completion schema: ' + schema);
        return json({ id: 'offline-completion', object: 'chat.completion', created: 1700000000,
          model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } });
      }
      throw new Error('Unexpected network request blocked by package smoke fixture: ' + url.origin + url.pathname);
    };
  `);
  const cleanEnv = { ...process.env, FIGJAM_MCP_CACHE_DIR: cache, SMOKE_REQUESTS_FILE: requestsFile,
    FIGMA_ACCESS_TOKEN: "offline-figma-token", LLM_API_KEY: "offline-model-key", LLM_BASE_URL: "https://offline-model.invalid/v1",
    LLM_MODEL_PRESET: "student-free", LLM_VISION_MODELS: "offline-test-model", LLM_TEXT_MODELS: "offline-test-model",
    LLM_FAST_TEXT_MODELS: "offline-test-model", LLM_VISION_MODEL: "", LLM_TEXT_MODEL: "", LLM_PROVIDER_REQUIRE_PARAMETERS: "false",
    SMOKE_LONG_CHECK: longCheck ? "1" : "0", INGEST_BOARD_VISION_BUDGET_MS: longCheck ? "120000" : "35000",
    LLM_REQUEST_TIMEOUT_MS: longCheck ? "90000" : "20000", LLM_SDK_MAX_RETRIES: "0", LLM_RATE_LIMIT_RETRIES: "0",
    INGEST_BOARD_MIN_VISION_SLOT_MS: "10000", INGEST_BOARD_VISION_CONCURRENCY: "1",
  };
  const serverArgs = ["--import", pathToFileURL(preload).href, binary];
  const transport = new StdioClientTransport({ command: process.execPath, args: serverArgs, cwd: consumer, env: cleanEnv, stderr: "pipe" });
  const client = new Client({ name: "package-smoke", version: "1.0.0" }, {
    supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  let errors = "";
  transport.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-8000); });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28", "Modern protocol must be negotiated, without a legacy fallback");
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["answer_from_board", "diagnose_llm_config", "diff_board", "get_board_context", "ingest_board"]);
    assert(listed.tools.every(tool => tool.annotations && tool.outputSchema), "Every tool must advertise annotations and output schema");
    const ingestArguments = { figmaFileUrl: "https://www.figma.com/board/SmokeBoard123/Smoke", ingestMode: "max_speed" };
    const initial = await ingestWithProgress(client, ingestArguments, "Modern initial ingest");
    assert.equal(initial.structuredContent.figmaVersion, "1");
    const updated = await ingestWithProgress(client, { ...ingestArguments, ingestMode: "max_quality", forceFullIngest: true }, "Modern visual ingest");
    assert.equal(updated.structuredContent.figmaVersion, "2");
    assert.equal(updated.structuredContent.qualityReport.visionClusters, 1);
    assert.equal(updated.structuredContent.qualityReport.incompleteClusters, 0);
    assert.notEqual(updated.structuredContent.snapshotId, initial.structuredContent.snapshotId);
    const reused = await client.callTool({ name: "ingest_board", arguments: { ...ingestArguments, ingestMode: "max_quality" } });
    assert(!reused.isError, JSON.stringify(reused));
    assert.equal(reused.structuredContent.snapshotId, updated.structuredContent.snapshotId);
    assert.equal(reused.structuredContent.qualityReport.cachedClusters, 1);
    const context = await client.callTool({ name: "get_board_context", arguments: { boardId: "SmokeBoard123" } });
    assert(!context.isError, JSON.stringify(context));
    assert.match(context.structuredContent.contextText, /Workshop finding version 2/);
    const answer = await client.callTool({ name: "answer_from_board", arguments: { boardId: "SmokeBoard123", question: "What is the workshop finding?" } });
    assert(!answer.isError, JSON.stringify(answer));
    assert.match(answer.structuredContent.answer, /Workshop finding version 2/);
    assert.equal(answer.structuredContent.citations.length, 1);
    assert.equal(answer.structuredContent.citations[0].nodeId, "1:1");
    assert.equal(answer.structuredContent.citations[0].snapshotId, updated.structuredContent.snapshotId);
    assert.equal(answer.structuredContent.citations[0].sourceType, "board_text");
    const diff = await client.callTool({ name: "diff_board", arguments: { boardId: "SmokeBoard123" } });
    assert(!diff.isError, JSON.stringify(diff));
    assert.equal(diff.structuredContent.stats.editedNodes, 1);

    // Exercise cell extraction, local retrieval, immutable source snapshots and
    // the user-visible diff together through the installed stdio entry point.
    const tableArguments = { figmaFileUrl: "https://www.figma.com/board/TableBoard123/Smoke", ingestMode: "max_speed" };
    const tableBefore = await ingestWithProgress(client, tableArguments, "Initial table ingest");
    const tableSearch = await client.callTool({ name: "get_board_context", arguments: { boardId: "TableBoard123", topic: "Budget 100" } });
    assert(!tableSearch.isError, JSON.stringify(tableSearch));
    const originalCell = tableSearch.structuredContent.evidence.find(item => item.nodeId === "T2:1;0;1");
    assert(originalCell, "A full table cell must be searchable");
    assert.equal(originalCell.text, "Budget 100");
    assert.equal(originalCell.sourceType, "table_cell");
    assert.equal(originalCell.modelDerived, false);
    assert.equal(originalCell.renderNodeId, "2:1");
    assert.equal(originalCell.row, 0);
    assert.equal(originalCell.column, 1);
    assert.equal(originalCell.snapshotId, tableBefore.structuredContent.snapshotId);
    assert.equal(new URL(originalCell.url).pathname, "/board/TableBoard123");
    assert.equal(new URL(originalCell.url).searchParams.get("node-id"), "2:1", "Cell evidence links to its renderable parent table");

    const tableAfter = await ingestWithProgress(client, tableArguments, "Updated table ingest");
    assert.notEqual(tableAfter.structuredContent.snapshotId, tableBefore.structuredContent.snapshotId);
    const updatedTableSearch = await client.callTool({ name: "get_board_context", arguments: { boardId: "TableBoard123", topic: "Budget 999" } });
    assert(!updatedTableSearch.isError, JSON.stringify(updatedTableSearch));
    const changedCell = updatedTableSearch.structuredContent.evidence.find(item => item.nodeId === "T2:1;0;1");
    assert.equal(changedCell?.text, "Budget 999");
    assert.equal(changedCell?.snapshotId, tableAfter.structuredContent.snapshotId);
    const historicalTable = await client.callTool({ name: "get_board_context", arguments: {
      boardId: "TableBoard123", snapshotId: tableBefore.structuredContent.snapshotId, nodeIds: ["T2:1;0;1"],
    } });
    assert(!historicalTable.isError, JSON.stringify(historicalTable));
    assert.equal(historicalTable.structuredContent.evidence[0]?.text, "Budget 100");
    const tableDiff = await client.callTool({ name: "diff_board", arguments: { boardId: "TableBoard123" } });
    assert(!tableDiff.isError, JSON.stringify(tableDiff));
    assert.equal(tableDiff.structuredContent.stats.editedNodes, 1, "One edited cell must count as one edited table node");
    assert.equal(tableDiff.structuredContent.stats.addedNodes, 0);
    assert.equal(tableDiff.structuredContent.stats.removedNodes, 0);
    assert.equal(tableDiff.structuredContent.stats.modifiedClusters, 1);
    assert.equal(tableDiff.structuredContent.baselineSnapshotId, tableBefore.structuredContent.snapshotId);
    assert.equal(tableDiff.structuredContent.currentSnapshotId, tableAfter.structuredContent.snapshotId);
    assert.deepEqual(tableDiff.structuredContent.tableCellChanges, [{
      tableNodeId: "2:1", cellId: "T2:1;0;1", changeType: "modified", previousText: "Budget 100", currentText: "Budget 999",
      previousRow: 0, currentRow: 0, previousColumn: 1, currentColumn: 1,
    }]);
    for (const request of [
      { name: "get_board_context", arguments: { boardId: "MissingBoard123" } },
      { name: "answer_from_board", arguments: { boardId: "MissingBoard123", question: "What changed?" } },
      { name: "ingest_board", arguments: { figmaFileUrl: "https://www.figma.com/board/DeniedBoard123/Smoke", ingestMode: "max_speed" } },
      { name: "diff_board", arguments: { boardId: "MissingBoard123" } },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true, `${request.name} must return a useful tool error`);
      assert(result.content.some(item => item.type === "text" && item.text.length > 0));
    }
    const diagnostic = await client.callTool({ name: "diagnose_llm_config", arguments: {} });
    assert(!diagnostic.isError, JSON.stringify(diagnostic));
    assert.equal(diagnostic.structuredContent.ok, true, "All three diagnostic probes must succeed with the offline provider");
    assert.equal(diagnostic.structuredContent.checks.length, 3);
    const invalid = await client.callTool({ name: "get_board_context", arguments: { boardId: "../private" } }).catch(error => error);
    assert(invalid instanceof Error || invalid.isError, "Invalid tool arguments must be rejected");
    if (longCheck) {
      console.log("Running opt-in 65-second installed stdio ingest; all provider responses remain synthetic and local.");
      const started = performance.now();
      const longIngest = await ingestWithProgress(client, {
        figmaFileUrl: "https://www.figma.com/board/LongBoard123/Smoke", ingestMode: "max_quality",
      }, "Long-running modern ingest");
      const elapsedMs = performance.now() - started;
      assert(elapsedMs >= 65_000, `Long ingest must actually exceed the client's common 60-second limit (${elapsedMs} ms)`);
      assert.equal(longIngest.structuredContent.qualityReport.visionClusters, 1);
      assert.equal(longIngest.structuredContent.qualityReport.incompleteClusters, 0);
      const longContext = await client.callTool({ name: "get_board_context", arguments: { boardId: "LongBoard123" } });
      assert(!longContext.isError, JSON.stringify(longContext));
      assert.equal(longContext.structuredContent.snapshotId, longIngest.structuredContent.snapshotId);
      assert.match(longContext.structuredContent.contextText, /Original progress source evidence/);
      console.log(`Long ingest returned its final result after ${Math.round(elapsedMs)} ms, following complete progress; persisted sources remain readable.`);
    }
  } catch (error) {
    throw new Error(`Installed MCP protocol check failed: ${error instanceof Error ? error.message : error}\n${errors}`);
  } finally {
    await client.close();
  }
  // Keep 2025-era MCP clients working while serving modern SDK-v2 clients.
  for (const protocolVersion of ["2025-11-25", "2025-06-18"]) {
    const legacy = new Client({ name: "legacy-package-smoke", version: "1.0.0" }, { supportedProtocolVersions: [protocolVersion] });
    const legacyTransport = new StdioClientTransport({ command: process.execPath, args: serverArgs, cwd: consumer, env: cleanEnv, stderr: "pipe" });
    try {
      await legacy.connect(legacyTransport);
      assert.equal(legacy.getNegotiatedProtocolVersion(), protocolVersion);
      assert.equal((await legacy.listTools()).tools.length, 5);
      const legacyIngest = await ingestWithProgress(legacy, {
        figmaFileUrl: `https://www.figma.com/board/LegacyBoard${protocolVersion.replaceAll("-", "")}/Smoke`, ingestMode: "max_speed",
      }, `${protocolVersion} ingest`);
      assert.equal(legacyIngest.structuredContent.clusterCount, 1);
      assert.equal(legacyIngest.structuredContent.figmaVersion, "1");
      const result = await legacy.callTool({ name: "get_board_context", arguments: { boardId: "SmokeBoard123" } });
      assert(!result.isError, `${protocolVersion} client could not read structured board context`);
      assert.match(result.structuredContent.contextText, /Workshop finding version 2/);
    } finally {
      await legacy.close();
    }
  }
  const unconfigured = new Client({ name: "unconfigured-package-smoke", version: "1.0.0" });
  const unconfiguredTransport = new StdioClientTransport({ command: process.execPath, args: serverArgs, cwd: consumer,
    env: { ...cleanEnv, FIGMA_ACCESS_TOKEN: "", LLM_API_KEY: "" }, stderr: "pipe" });
  try {
    await unconfigured.connect(unconfiguredTransport);
    const ingest = await unconfigured.callTool({ name: "ingest_board", arguments: {
      figmaFileUrl: "https://www.figma.com/board/SmokeBoard123/Smoke", ingestMode: "max_speed",
    } });
    assert.equal(ingest.isError, true, "Missing Figma token must return a tool error");
    const answer = await unconfigured.callTool({ name: "answer_from_board", arguments: { boardId: "SmokeBoard123", question: "What is the workshop finding?" } });
    assert.equal(answer.isError, true, "Missing provider key must return a tool error for an answer requiring a model");
    const diagnostic = await unconfigured.callTool({ name: "diagnose_llm_config", arguments: {} });
    assert(!diagnostic.isError, JSON.stringify(diagnostic));
    assert.equal(diagnostic.structuredContent.ok, false, "Missing provider key must be diagnosed without network access");
  } finally {
    await unconfigured.close();
  }
  const requests = (await readFile(requestsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line).kind);
  const expectedRequests = { figma_file: 2, figma_metadata: 1, figma_render: 1, image_download: 1,
    figjam_cluster_refinement: longCheck ? 2 : 1, figjam_evidence_answer: 1, diagnose_text_json: 1, diagnose_fast_text_json: 1, diagnose_vision_json: 1, figma_denied: 1,
    table_file: 2, table_metadata: 1, legacy_file: 2,
    ...(longCheck ? { long_file: 1, long_render: 1, long_image: 1, long_model_delay_started: 1, long_model_delay_completed: 1 } : {}),
  };
  for (const [kind, count] of Object.entries(expectedRequests)) {
    assert.equal(requests.filter(request => request === kind).length, count, `Unexpected ${kind} request count`);
  }
  assert.equal(requests.length, Object.values(expectedRequests).reduce((sum, count) => sum + count, 0), "Unexpected provider work was attempted");
  console.log(`Verified ${metadata.name}@${metadata.version}: production-only install, executable, successful calls to all five tools, offline Figma/vision/answer/diagnostic fixtures, table cell search and single-node edit diff, persisted cache reuse, modern/legacy ingest progress followed by final responses, error handling${longCheck ? ", and a real >60-second ingest" : ""}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
