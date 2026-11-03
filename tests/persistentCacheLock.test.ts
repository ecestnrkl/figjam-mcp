import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const hooks = vi.hoisted(() => ({
  delay: undefined as (() => void) | undefined,
  beforeRetire: undefined as (() => Promise<void>) | undefined,
  retired: 0,
  active: 0,
  maximumActive: 0,
  owner: undefined as unknown,
  ownerPublished: undefined as (() => void) | undefined,
  afterRetireAttempt: undefined as ((succeeded: boolean) => void) | undefined,
  beforeSourceRename: undefined as (() => Promise<void>) | undefined,
  afterLockDirectoryCreated: undefined as (() => Promise<void>) | undefined,
  ownerLinkFailed: undefined as (() => void) | undefined,
  rejectedOwner: undefined as unknown,
}));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: (...args: Parameters<typeof actual.setTimeout>) => {
    if (hooks.delay) { hooks.delay(); return Promise.resolve(); }
    return actual.setTimeout(...args);
  } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const ownerPublished = async (filename: import("node:fs").PathLike) => {
    hooks.owner = JSON.parse(await actual.readFile(filename, "utf8"));
    hooks.active++; hooks.maximumActive = Math.max(hooks.maximumActive, hooks.active);
    hooks.ownerPublished?.();
  };
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      if (String(args[0]).endsWith(path.sep + ".write-lock")) await hooks.afterLockDirectoryCreated?.();
      return result;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      try { await actual.link(...args); } catch (error) {
        if (String(args[1]).endsWith(path.sep + "owner.json")) {
          hooks.rejectedOwner = JSON.parse(await actual.readFile(args[1], "utf8"));
          hooks.ownerLinkFailed?.();
        }
        throw error;
      }
      if (String(args[1]).endsWith(path.sep + "owner.json")) await ownerPublished(args[1]);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith(path.sep + ".retired")) await hooks.beforeRetire?.();
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (path.basename(String(args[1])).startsWith("source-")) await hooks.beforeSourceRename?.();
      try { await actual.rename(...args); } catch (error) {
        if (String(args[1]).endsWith(".retired")) hooks.afterRetireAttempt?.(false);
        throw error;
      }
      if (String(args[1]).endsWith(".retired")) { hooks.retired++; hooks.afterRetireAttempt?.(true); }
      if (String(args[1]).endsWith(path.sep + "owner.json")) {
        await ownerPublished(args[1]);
      }
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (String(args[0]).endsWith(path.sep + ".write-lock")) hooks.active--;
    },
  };
});
let root: string;
const input: BoardData = { boardId: "locks", fileKey: "locks", cacheKey: "first", createdAt: 1,
  docStructureHint: "freeform", nodes: [{ id: "n", name: "Note", type: "STICKY", text: "first", x: 0, y: 0, width: 10, height: 10, rotation: 0 }], clusters: [] };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "figjam-lock-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", root);
  vi.resetModules();
  hooks.delay = undefined; hooks.beforeRetire = undefined;
  hooks.retired = 0; hooks.active = 0; hooks.maximumActive = 0; hooks.owner = undefined;
  hooks.ownerPublished = undefined; hooks.afterRetireAttempt = undefined; hooks.beforeSourceRename = undefined;
  hooks.afterLockDirectoryCreated = undefined; hooks.ownerLinkFailed = undefined; hooks.rejectedOwner = undefined;
  await mkdir(path.join(root, "v4", ".write-lock"), { recursive: true });
});
afterEach(async () => {
  hooks.delay = undefined; hooks.beforeRetire = undefined;
  hooks.ownerPublished = undefined; hooks.afterRetireAttempt = undefined; hooks.beforeSourceRename = undefined;
  hooks.afterLockDirectoryCreated = undefined; hooks.ownerLinkFailed = undefined; hooks.rejectedOwner = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each(["local", "legacy"])("recovers a %s lock owned by a terminated process without waiting", async (kind) => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  await writeFile(path.join(root, "v4", ".write-lock", "owner.json"), JSON.stringify({ pid, ...(kind === "local" ? { hostname: hostname() } : {}), token: "terminated" }));
  const waited = vi.fn(() => { throw new Error("stale lock must not wait"); }); hooks.delay = waited;
  const cache = await import("../src/lib/persistentCache.js");
  await cache.persistBoard(input);
  expect(waited).not.toHaveBeenCalled();
  expect(hooks.retired).toBe(1);
  expect((await cache.readLatestBoard("locks"))?.nodes[0]?.text).toBe("first");
});

it.each(["live local owner", "remote hostname", "unreadable owner.json"])("recovers a lock older than ten minutes with %s without waiting", async (kind) => {
  const lockPath = path.join(root, "v4", ".write-lock");
  await writeFile(path.join(lockPath, "owner.json"), kind === "unreadable owner.json" ? "{" : JSON.stringify({
    pid: process.pid, hostname: kind === "remote hostname" ? "another-host.invalid" : hostname(), token: "occupied",
  }));
  const stale = new Date(Date.now() - 601_000);
  await utimes(lockPath, stale, stale);
  const waited = vi.fn(() => { throw new Error("stale lock must not wait"); }); hooks.delay = waited;
  const cache = await import("../src/lib/persistentCache.js");
  await cache.persistBoard(input);
  expect(waited).not.toHaveBeenCalled();
  expect(hooks.retired).toBe(1);
  expect((await readdir(path.join(root, "v4"))).filter(name => name.startsWith(".write-lock-") && name.endsWith(".retired"))).toHaveLength(1);
  expect((await cache.readLatestBoard("locks"))?.nodes[0]?.text).toBe("first");
});

it.each(["live", "remote", "unknown", "fresh ownerless"])("waits ten seconds before reporting a %s lock as busy", async (kind) => {
  if (kind !== "fresh ownerless") {
    await writeFile(path.join(root, "v4", ".write-lock", "owner.json"), JSON.stringify({
      pid: kind === "unknown" ? -1 : process.pid,
      hostname: kind === "remote" ? "another-host.invalid" : hostname(), token: "occupied",
    }));
  }
  const clock = Date.now(); let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock + elapsed);
  hooks.delay = () => { elapsed += 10_000; };
  const cache = await import("../src/lib/persistentCache.js");
  await expect(cache.persistBoard(input)).rejects.toMatchObject({ code: "EBUSY", message: expect.stringContaining("another server process is writing; retry ingest_board") });
  expect(elapsed).toBe(10_000);
  expect(hooks.retired).toBe(0);
});

it("recovers an ownerless lock only after thirty seconds", async () => {
  const stale = new Date(Date.now() - 31_000);
  await utimes(path.join(root, "v4", ".write-lock"), stale, stale);
  hooks.delay = () => { throw new Error("stale lock must not wait"); };
  const cache = await import("../src/lib/persistentCache.js");
  await cache.persistBoard(input);
  expect(hooks.retired).toBe(1);
  expect(await cache.readLatestBoard("locks")).toBeDefined();
});

it("lets exactly one simultaneous recovery win and serializes both publications", async () => {
  const stale = new Date(Date.now() - 31_000);
  await utimes(path.join(root, "v4", ".write-lock"), stale, stale);
  let bothSeen!: () => void; let firstOwnerPublished!: () => void; let loserFinished!: () => void;
  const bothReady = new Promise<void>(resolve => { bothSeen = resolve; });
  const firstOwned = new Promise<void>(resolve => { firstOwnerPublished = resolve; });
  const loserAttempted = new Promise<void>(resolve => { loserFinished = resolve; });
  let contenders = 0;
  hooks.delay = () => { if (contenders === 0) throw new Error("stale lock must not wait"); };
  hooks.beforeRetire = async () => {
    if (++contenders === 1) await bothReady;
    else { bothSeen(); await firstOwned; }
  };
  hooks.ownerPublished = firstOwnerPublished;
  hooks.afterRetireAttempt = succeeded => { if (!succeeded) loserFinished(); };
  // Keep the first new owner active until the delayed stale observer tries its rename.
  hooks.beforeSourceRename = () => loserAttempted;
  const left = await import("../src/lib/persistentCache.js");
  vi.resetModules();
  const right = await import("../src/lib/persistentCache.js");
  await Promise.all([
    left.persistBoard(input),
    right.persistBoard({ ...input, cacheKey: "second", createdAt: 2, nodes: [{ ...input.nodes[0]!, text: "second" }] }),
  ]);
  expect(hooks.retired).toBe(1);
  expect(hooks.maximumActive).toBe(1);
  expect(hooks.active).toBe(0);
  expect(await left.readBoardHistory("locks")).toHaveLength(2);
});

it("records this process and hostname in a new lock", async () => {
  await rm(path.join(root, "v4", ".write-lock"), { recursive: true });
  hooks.active = 0;
  const cache = await import("../src/lib/persistentCache.js");
  await cache.persistBoard(input);
  expect(hooks.owner).toMatchObject({ pid: process.pid, hostname: hostname(), token: expect.any(String) });
});

it("does not let a suspended owner initializer overwrite a recovered live lock", async () => {
  await rm(path.join(root, "v4", ".write-lock"), { recursive: true });
  hooks.active = 0;
  const clock = Date.now(); let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock + elapsed);
  let firstCreated!: () => void; let resumeFirst!: () => void; let rejected!: () => void;
  const created = new Promise<void>(resolve => { firstCreated = resolve; });
  const resume = new Promise<void>(resolve => { resumeFirst = resolve; });
  const rejectedLink = new Promise<void>(resolve => { rejected = resolve; });
  let directories = 0; let liveOwner: unknown;
  hooks.delay = () => { throw new Error("ownerless recovery must not wait"); };
  hooks.afterLockDirectoryCreated = async () => { if (++directories === 1) { firstCreated(); await resume; } };
  hooks.ownerPublished = () => { liveOwner ??= hooks.owner; resumeFirst(); };
  hooks.ownerLinkFailed = rejected;
  hooks.beforeSourceRename = () => rejectedLink;
  const left = await import("../src/lib/persistentCache.js");
  vi.resetModules();
  const right = await import("../src/lib/persistentCache.js");
  const first = left.persistBoard(input);
  const firstResult = expect(first).rejects.toMatchObject({ code: "EBUSY" });
  await created;
  elapsed = 31_000;
  await Promise.all([
    firstResult,
    right.persistBoard({ ...input, cacheKey: "second", createdAt: 2, nodes: [{ ...input.nodes[0]!, text: "second" }] }),
  ]);
  expect(hooks.rejectedOwner).toEqual(liveOwner);
  expect(hooks.maximumActive).toBe(1);
  expect(hooks.active).toBe(0);
  expect(await right.readBoardHistory("locks")).toHaveLength(1);
  await left.persistBoard(input);
  expect(await left.readBoardHistory("locks")).toHaveLength(2);
});
