import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseSmokeOptions, requireNewArtifactDirectory, retainVerifiedArtifact } from "./package-smoke-artifact.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run package:smoke");
const { longCheck, artifactDir } = parseSmokeOptions(process.argv.slice(2));
if (artifactDir) await requireNewArtifactDirectory(artifactDir);
const temporary = await mkdtemp(join(tmpdir(), "figjam-context-mcp-"));
let testedArtifact;

async function ingestWithProgress(client, arguments_, label) {
  const transport = client.transport;
  assert(transport, `${label}: client must be connected`);
  const originalOnMessage = transport.onmessage;
  const originalSend = transport.send;
  const requests = [];
  const received = [];
  // SDK 2.3.1 defers notification handlers to a microtask, but removes progress
  // handlers synchronously on a response. If complete and the result share one
  // stdio read, onprogress loses complete despite correct wire ordering. Observe
  // the public transport boundary before SDK dispatch, keeping every assertion.
  transport.send = function (message, ...options) {
    if (message.method === "tools/call" && message.params?.name === "ingest_board") {
      requests.push({ id: message.id, progressToken: message.params._meta?.progressToken });
    }
    return originalSend.call(this, message, ...options);
  };
  transport.onmessage = function (message, ...extra) {
    if (message.method === "notifications/progress") received.push({ kind: "progress", params: message.params });
    else if (requests.some(request => request.id === message.id) && ("result" in message || "error" in message)) {
      received.push({ kind: "response", id: message.id });
    }
    return originalOnMessage?.call(this, message, ...extra);
  };
  try {
    const result = await client.callTool({ name: "ingest_board", arguments: arguments_ }, {
      timeout: 180_000,
      maxTotalTimeout: 180_000,
      resetTimeoutOnProgress: false,
      onprogress: () => {}, // Request progress through the normal SDK path.
    });
    assert(!result.isError, `${label}: ${JSON.stringify(result)}`);
    assert.equal(requests.length, 1, `${label}: expected one ingest request`);
    assert.notEqual(requests[0].progressToken, undefined, `${label}: progress must be requested`);
    const events = received.filter(message => message.kind === "progress").map(message => message.params);
    assert(events.every(event => event.progressToken === requests[0].progressToken), `${label}: progress token must match the ingest request`);
    assert.deepEqual(events.map(event => event.message), ["fetch", "extract", "cluster", "interpret", "persist", "complete"],
      `${label}: a final response must arrive after all ingest progress phases`);
    assert.deepEqual(events.map(event => event.progress), [0, 1, 2, 3, 4, 5]);
    assert(events.every(event => event.total === 5));
    assert.deepEqual(received.map(message => message.kind), ["progress", "progress", "progress", "progress", "progress", "progress", "response"],
      `${label}: all six progress notifications must precede the final response`);
    assert.equal(received.at(-1).id, requests[0].id, `${label}: final response must match the ingest request`);
    return result;
  } finally {
    transport.onmessage = originalOnMessage;
    transport.send = originalSend;
  }
}

/** A synthetic RGB PNG with colour blocks and a grid; no board content. */
function syntheticPng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      const line = x % 100 < 2 || y % 100 < 2;
      const block = (Math.floor(x * 6 / width) + Math.floor(y * 4 / height)) % 3;
      raw[o] = line ? 0 : block === 0 ? 220 : 40;
      raw[o + 1] = line ? 0 : block === 1 ? 200 : 60;
      raw[o + 2] = line ? 0 : block === 2 ? 230 : 50;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(data.length, 0);
    frame.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Width and height from a JPEG frame header. */
const jpegSizeSource = `(bytes => {
  for (let offset = 2; offset + 9 <= bytes.length && bytes[offset] === 0xff; offset += 2 + bytes.readUInt16BE(offset + 2)) {
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
  }
})`;

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

  // The installed package scales a large original on a worker thread, and cancelling stops that worker.
  const largeOriginal = join(temporary, "large-original.png");
  await writeFile(largeOriginal, syntheticPng(2400, 1800));
  const workerCheck = join(temporary, "worker-check.mjs");
  await writeFile(workerCheck, `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { readFile } from 'node:fs/promises';
    import { resizeInWorker } from ${JSON.stringify(pathToFileURL(join(installed, "dist", "lib", "imageWorker.js")).href)};
    const jpegSize = ${jpegSizeSource};
    const image = await readFile(process.argv[2]);
    const workers = [];
    process.on('worker', worker => workers.push(worker));
    const started = performance.now();
    assert.deepEqual(jpegSize(await resizeInWorker(image, 'image/png')), [1024, 768]);
    const elapsed = Math.round(performance.now() - started);
    assert.equal(workers.length, 1, 'Resizing must run on a worker thread');
    const controller = new AbortController();
    const reason = new Error('Synthetic ingest cancelled');
    const cancelled = resizeInWorker(image, 'image/png', controller.signal);
    const exited = once(workers[0], 'exit');
    setImmediate(() => controller.abort(reason));
    await assert.rejects(cancelled, error => error === reason);
    await exited;
    assert.deepEqual(jpegSize(await resizeInWorker(image, 'image/png')), [1024, 768]);
    assert.equal(workers.length, 2, 'The next image must start a new worker');
    console.log('Worker resized 2400 x 1800 px to 1024 x 768 px in ' + elapsed + ' ms; cancellation stopped the worker.');
  `);
  console.log(run(process.execPath, [workerCheck, largeOriginal], { cwd: consumer }).stdout.trim());

  const cache = join(temporary, "cache");
  const requestsFile = join(temporary, "fixture-requests.jsonl");
  const preload = join(temporary, "offline-provider.mjs");
  // Only replace the network boundary. Every tool, parser, provider SDK, cache
  // operation and stdio response runs from the installed production artifact.
  // Unexpected requests fail closed: no fixture can contact a real provider.
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    let fileReads = 0;
    let tableReads = 0;
    let longRenderPending = false;
    const record = kind => appendFileSync(process.env.SMOKE_REQUESTS_FILE, JSON.stringify({ kind }) + '\\n');
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const jpegSize = ${jpegSizeSource};
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
        if (url.pathname === '/v1/files/SmokeBoard123') {
          record('figma_file');
          // The board changes once, between the first and second read.
          fileReads = Math.min(fileReads + 1, 2);
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
        if (url.pathname === '/v1/files/OverviewBoard123') {
          record('overview_file');
          return json({ version: '1', document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
              id: '0:1', name: 'Synthetic overview', type: 'CANVAS',
              children: Array.from({ length: 8 }, (_, section) => ({
                id: '600:' + (section + 1), name: 'Section ' + (section + 1), type: 'SECTION',
                absoluteBoundingBox: { x: section * 1000, y: 0, width: 900, height: 900 },
                children: Array.from({ length: 16 }, (_, note) => ({
                  id: '700:' + (section * 16 + note + 1), name: 'Note', type: 'STICKY',
                  characters: 'Synthetic note ' + (section + 1) + '/' + (note + 1) + '.',
                  absoluteBoundingBox: { x: section * 1000 + (note % 4) * 180, y: Math.floor(note / 4) * 180, width: 160, height: 120 }
                }))
              }))
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
        if (url.pathname === '/v1/files/ImageBoard123') {
          record('image_board_file');
          return json({ version: '1', document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
              id: '0:1', name: 'Photo wall', type: 'CANVAS', children: [{
                id: '4:1', name: 'Photo', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageRef: 'synthetic-photo' }],
                absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 80 }
              }]
            }]
          } });
        }
        if (url.pathname === '/v1/files/ImageBoard123/images') {
          record('figma_image_fills');
          return json({ error: false, status: 200, meta: { images: { 'synthetic-photo': 'https://offline-images.invalid/photo.png' } } });
        }
        if (url.pathname === '/v1/images/ImageBoard123') record('image_board_render');
        if (url.pathname === '/v1/images/LongBoard123') {
          assert.equal(process.env.SMOKE_LONG_CHECK, '1');
          record('long_render');
          assert.equal(url.searchParams.get('version'), null, 'Renders show the current file');
          assert.equal(url.searchParams.get('ids'), '3:1');
          longRenderPending = true;
          return json({ images: { '3:1': 'https://offline-images.invalid/long.png' } });
        }
        if (url.pathname === '/v1/images/SmokeBoard123') {
          record('figma_render');
          assert.equal(url.searchParams.get('version'), null, 'Renders show the current file');
          assert.equal(url.searchParams.get('ids'), '1:1');
          return json({ images: { '1:1': 'https://offline-images.invalid/evidence.png' } });
        }
      }
      if (url.href === 'https://offline-images.invalid/photo.png') {
        record('original_download');
        const original = readFileSync(process.env.SMOKE_LARGE_ORIGINAL);
        return new Response(original, { headers: { 'content-type': 'image/png', 'content-length': String(original.length) } });
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
          const parts = body.messages.find(message => message.role === 'user')?.content;
          const imageUrls = Array.isArray(parts) ? parts.filter(part => part.type === 'image_url').map(part => part.image_url.url) : [];
          if (Array.isArray(parts) && /- 4:1 /.test(parts[0].text)) {
            assert.equal(imageUrls.length, 1, 'The image cluster sends its original');
            assert.match(imageUrls[0], /^data:image\\/jpeg;base64,/, 'The 2400 px PNG original arrives as JPEG');
            assert.deepEqual(jpegSize(Buffer.from(imageUrls[0].split(',')[1], 'base64')), [1024, 768], 'The original arrives scaled down');
            record('bounded_original');
            reply = { label: 'Synthetic photo', summary: 'A synthetic photo on the photo wall.', confirmedNodeIds: ['4:1'] };
          } else if (longRenderPending) {
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
          reply = { kind: 'answer', language: 'en', answer: 'Workshop finding version 2.', evidenceIds: [evidenceId] };
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
  const cleanEnv = { ...process.env, FIGJAM_MCP_CACHE_DIR: cache, SMOKE_REQUESTS_FILE: requestsFile, SMOKE_LARGE_ORIGINAL: largeOriginal,
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
    assert.match(reused.structuredContent.summary, /The board content is unchanged since the previous ingest\./);
    const context = await client.callTool({ name: "get_board_context", arguments: { boardId: "SmokeBoard123" } });
    assert(!context.isError, JSON.stringify(context));
    assert.match(context.content[0].text, /Workshop finding version 2/);
    assert(context.structuredContent.evidence.some(item => /Workshop finding version 2/.test(item.text)));
    assert.equal(context.structuredContent.snapshotId, updated.structuredContent.snapshotId);
    const sourceExcerpt = context.structuredContent.evidence.find(item => item.sourceType === "board_text");
    assert(sourceExcerpt, "Full context must retain original source evidence");
    assert.equal(sourceExcerpt.snapshotId, undefined, "Full excerpts inherit the response snapshotId");
    assert.equal(sourceExcerpt.chunkIndex, undefined, "Chunk zero is omitted");
    assert.equal(sourceExcerpt.modelDerived, undefined, "False source flags are omitted");
    assert.equal(sourceExcerpt.truncated, undefined, "False truncation flags are omitted");
    assert.equal(new URL(sourceExcerpt.url).searchParams.get("node-id"), sourceExcerpt.nodeId);
    assert.doesNotMatch(context.structuredContent.contextText, /Workshop finding version 2/, "Excerpt text must appear once in structuredContent");
    const outside = await client.callTool({ name: "get_board_context", arguments: { boardId: "SmokeBoard123", outsideSections: true } });
    assert(!outside.isError, JSON.stringify(outside));
    assert.equal(outside.structuredContent.totalMatched, context.structuredContent.totalMatched, "A board without sections is read whole outside sections");
    assert.match(outside.structuredContent.contextText, /## Outside sections/);
    const answer = await client.callTool({ name: "answer_from_board", arguments: { boardId: "SmokeBoard123", question: "What is the workshop finding?" } });
    assert(!answer.isError, JSON.stringify(answer));
    assert.match(answer.structuredContent.answer, /Workshop finding version 2/);
    assert.equal(answer.structuredContent.citations.length, 1);
    assert.equal(answer.structuredContent.citations[0].nodeId, "1:1");
    assert.equal(answer.structuredContent.citations[0].snapshotId, updated.structuredContent.snapshotId);
    assert.equal(answer.structuredContent.citations[0].sourceType, "board_text");
    // Clients that pass only the text content to the model get the sources too.
    assert.match(answer.content[0].text, /\n\nSources \(untrusted board data\):\n- 1:1 in "[^"\n]+": "Workshop finding version 2" https:\/\/www\.figma\.com\/board\/SmokeBoard123\?node-id=1%3A1$/);
    const diff = await client.callTool({ name: "diff_board", arguments: { boardId: "SmokeBoard123" } });
    assert(!diff.isError, JSON.stringify(diff));
    assert.equal(diff.structuredContent.stats.editedNodes, 1);
    assert.match(diff.content[0].text, /\nEdited nodes \(1\):\n- sticky 1:1 outside sections: "Workshop finding version 1" → "Workshop finding version 2"\n/);
    assert.deepEqual(diff.structuredContent.nodeChanges, [{
      nodeId: "1:1", changeType: "edited", nodeType: "STICKY", previousText: "Workshop finding version 1",
      currentText: "Workshop finding version 2", url: "https://www.figma.com/board/SmokeBoard123?node-id=1%3A1", changes: ["text"],
    }]);

    // The production package returns compact excerpts in both MCP channels,
    // then resolves their source IDs against the same immutable snapshot.
    const overviewIngest = await ingestWithProgress(client, {
      figmaFileUrl: "https://www.figma.com/board/OverviewBoard123/Smoke", ingestMode: "max_speed",
    }, "Synthetic overview ingest");
    const overview = await client.callTool({ name: "get_board_context", arguments: {
      boardId: "OverviewBoard123", nodeIds: Array.from({ length: 8 }, (_, index) => `600:${index + 1}`), limit: 1,
    } });
    assert(!overview.isError, JSON.stringify(overview));
    const compact = overview.structuredContent;
    assert.equal(compact.snapshotId, overviewIngest.structuredContent.snapshotId);
    assert.equal(compact.totalMatched, 128);
    assert.equal(compact.overview?.shownEvidence, 128, "Overview ignores even an explicit limit of one");
    assert.equal(compact.overview.shortenedEvidence, 0);
    assert.deepEqual(compact.evidence, []);
    assert.deepEqual(compact.clusters, []);
    assert.equal(compact.truncation.remainingEvidence, 0);
    assert.equal(compact.nextCursor, undefined);
    assert.match(compact.overview.text, /700:1: Synthetic note 1\/1\./);
    assert.match(overview.content[0].text, /700:1: Synthetic note 1\/1\./);
    assert.equal(JSON.stringify(compact).match(/Synthetic note 1\/1\./g)?.length, 1, "Structured overview text is not repeated");
    assert(overview.content[0].text.length <= 12000);
    assert(JSON.stringify(compact).length <= 12000);
    assert(Buffer.byteLength(JSON.stringify(overview), "utf8") <= 128 * 1024);
    const fullReadback = await client.callTool({ name: "get_board_context", arguments: {
      boardId: "OverviewBoard123", snapshotId: compact.snapshotId, nodeIds: ["700:1"], detail: "full",
    } });
    assert(!fullReadback.isError, JSON.stringify(fullReadback));
    assert.equal(fullReadback.structuredContent.snapshotId, compact.snapshotId);
    assert.equal(fullReadback.structuredContent.overview, undefined);
    assert.equal(fullReadback.structuredContent.evidence[0]?.text, "Synthetic note 1/1.");
    assert.equal(fullReadback.structuredContent.evidence[0]?.snapshotId, undefined);
    assert.equal(new URL(fullReadback.structuredContent.evidence[0].url).searchParams.get("node-id"), "700:1");

    // Exercise table rows, local retrieval, immutable source snapshots and
    // the user-visible diff together through the installed stdio entry point.
    const tableArguments = { figmaFileUrl: "https://www.figma.com/board/TableBoard123/Smoke", ingestMode: "max_speed" };
    const tableBefore = await ingestWithProgress(client, tableArguments, "Initial table ingest");
    const tableSearch = await client.callTool({ name: "get_board_context", arguments: { boardId: "TableBoard123", topic: "Budget 100" } });
    assert(!tableSearch.isError, JSON.stringify(tableSearch));
    const originalRow = tableSearch.structuredContent.evidence.find(item => item.sourceType === "table_row");
    assert(originalRow, "A table row must be searchable");
    assert.equal(originalRow.text, "Simulator | Budget 100");
    assert.equal(originalRow.nodeId, "2:1");
    assert.equal(originalRow.modelDerived ?? false, false);
    assert.equal(originalRow.renderNodeId, "2:1");
    assert.equal(originalRow.row, 0);
    assert.equal(originalRow.column, undefined);
    assert.equal(tableSearch.structuredContent.snapshotId, tableBefore.structuredContent.snapshotId);
    assert.equal(originalRow.snapshotId, undefined, "Row evidence inherits the response snapshotId");
    assert.equal(new URL(originalRow.url).pathname, "/board/TableBoard123");
    assert.equal(new URL(originalRow.url).searchParams.get("node-id"), "2:1", "Row evidence links to its renderable table");
    assert.match(tableSearch.content[0].text, /Table 2:1 · original · 1 row × 2 columns · row 0 shown · /);

    const tableAfter = await ingestWithProgress(client, tableArguments, "Updated table ingest");
    assert.notEqual(tableAfter.structuredContent.snapshotId, tableBefore.structuredContent.snapshotId);
    const updatedTableSearch = await client.callTool({ name: "get_board_context", arguments: { boardId: "TableBoard123", topic: "Budget 999" } });
    assert(!updatedTableSearch.isError, JSON.stringify(updatedTableSearch));
    const changedRow = updatedTableSearch.structuredContent.evidence.find(item => item.sourceType === "table_row");
    assert.equal(changedRow?.text, "Simulator | Budget 999");
    assert.equal(updatedTableSearch.structuredContent.snapshotId, tableAfter.structuredContent.snapshotId);
    assert.equal(changedRow?.snapshotId, undefined);
    const historicalTable = await client.callTool({ name: "get_board_context", arguments: {
      boardId: "TableBoard123", snapshotId: tableBefore.structuredContent.snapshotId, nodeIds: ["T2:1;0;1"],
    } });
    assert(!historicalTable.isError, JSON.stringify(historicalTable));
    assert.equal(historicalTable.structuredContent.evidence[0]?.text, "Simulator | Budget 100", "A cell ID returns its row");
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
      previousRow: 0, currentRow: 0, previousColumn: 1, currentColumn: 1, tableName: "Budget table", rowLabel: "Simulator",
    }]);
    assert.deepEqual(tableDiff.structuredContent.nodeChanges, [], "Changed cells explain the edited table");
    assert.match(tableDiff.content[0].text,
      /\nTable cells \(1\):\n- table "Budget table" 2:1 outside sections, row 1 "Simulator", column 2: "Budget 100" → "Budget 999"\n/);
    // An image node is read from GET image fills (Tier 2) and its original download, without a render request.
    // focusNodeIds puts the image first; an unknown ID is reported, not rejected.
    const imageIngest = await ingestWithProgress(client, { figmaFileUrl: "https://www.figma.com/board/ImageBoard123/Smoke", ingestMode: "balanced",
      focusNodeIds: ["4:1", "9:404"] }, "Image ingest");
    assert.equal(imageIngest.structuredContent.qualityReport.visionClusters, 1);
    assert.deepEqual(imageIngest.structuredContent.qualityReport.focus,
      { requestedIds: ["4:1", "9:404"], foundIds: ["4:1"], imageClusters: 1, interpreted: 1, pending: 0 });
    assert.match(imageIngest.structuredContent.summary, /Focus: 1 of 1 image cluster interpreted, 0 pending\. 1 of 2 focusNodeIds not found on the board: 9:404\./);
    assert.deepEqual(imageIngest.structuredContent.qualityReport.figmaRequests, { imageFills: 1, renders: 0 });
    assert.match(imageIngest.structuredContent.summary, /Figma requests for images: 1 image fills request \(Tier 2\), 0 render requests \(Tier 1\)\./);

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
      assert.match(longContext.content[0].text, /Original progress source evidence/);
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
      assert(result.structuredContent.evidence.some(item => /Workshop finding version 2/.test(item.text)));
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
  // Every ingest downloads its board; the unchanged re-ingest reuses the cached interpretation.
  const expectedRequests = { figma_file: 3, figma_render: 1, image_download: 1,
    figjam_cluster_refinement: longCheck ? 3 : 2, figjam_evidence_answer: 1, diagnose_text_json: 1, diagnose_fast_text_json: 1, diagnose_vision_json: 1, figma_denied: 1,
    table_file: 2, overview_file: 1, legacy_file: 2, image_board_file: 1, figma_image_fills: 1, original_download: 1, bounded_original: 1,
    ...(longCheck ? { long_file: 1, long_render: 1, long_image: 1, long_model_delay_started: 1, long_model_delay_completed: 1 } : {}),
  };
  for (const [kind, count] of Object.entries(expectedRequests)) {
    assert.equal(requests.filter(request => request === kind).length, count, `Unexpected ${kind} request count`);
  }
  assert.equal(requests.length, Object.values(expectedRequests).reduce((sum, count) => sum + count, 0), "Unexpected provider work was attempted");
  if (artifactDir) testedArtifact = { bytes: await readFile(archive), name: archives[0] };
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (artifactDir) {
  const artifact = await retainVerifiedArtifact(testedArtifact.bytes, testedArtifact.name, artifactDir);
  console.log(`Retained tested tarball: ${artifact.archivePath}`);
  console.log(`SHA-256: ${artifact.checksum}`);
}
console.log(`Verified ${metadata.name}@${metadata.version}: production-only install, executable, successful calls to all five tools, offline Figma/vision/answer/diagnostic fixtures, compact overview and full source readback, a large image from image fills scaled down on a worker thread without a render, table row search and single-cell edit diff, persisted cache reuse, modern/legacy ingest progress followed by final responses, error handling${longCheck ? ", and a real >60-second ingest" : ""}`);
