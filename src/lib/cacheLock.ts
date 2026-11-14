import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Recursive mode enables Node's retries for the temporary owner file as well.
const cleanupOptions = { recursive: true, force: true, maxRetries: 3, retryDelay: 20 };
const PERMISSION_HINT = "check permissions of FIGJAM_MCP_CACHE_DIR or the cache directory, then retry ingest_board.";

/** Directory locks coordinate independent server processes sharing the same cache. */
export async function withCacheLock<T>(directory: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lockPath = path.join(directory, ".write-lock");
  const token = randomUUID();
  const started = Date.now();
  // Prepare the owner before creating a lock, then publish it exclusively. An
  // initializer resumed after ownerless recovery must not overwrite the new owner.
  const temporary = path.join(directory, `.write-owner-${token}.tmp`);
  try {
    const ownerFile = await open(temporary, "wx", 0o600);
    try {
      await ownerFile.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token }), "utf8");
      await ownerFile.sync();
    } finally { await ownerFile.close(); }
    for (;;) {
      signal?.throwIfAborted();
      let created = false;
      try {
        await mkdir(lockPath, { mode: 0o700 });
        created = true;
        try { await link(temporary, path.join(lockPath, "owner.json")); }
        catch (error) {
          // Only an empty, still-unpublished lock may be removed here.
          await rmdir(lockPath).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        const failure = code(error);
        const retryableMkdirError = !created && isTransientLockError(failure);
        if (failure !== "EEXIST" && !retryableMkdirError) throw error;
        const recovery = await reclaimAbandonedLock(lockPath);
        if (recovery === "retired" || (recovery === "missing" && !retryableMkdirError)) continue;
        if (Date.now() - started >= 10_000) {
          if (recovery instanceof Error) {
            recovery.message += `; ${PERMISSION_HINT}`;
            throw recovery;
          }
          if (retryableMkdirError && error instanceof Error &&
            await lstat(lockPath).then(() => false, error => code(error) === "ENOENT")) {
            error.message += `; ${PERMISSION_HINT}`;
            throw error;
          }
          throw Object.assign(new Error("another server process is writing; retry ingest_board"), { code: "EBUSY" });
        }
        await delay(20, undefined, { signal });
      }
    }
    try { return await operation(); } finally {
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
        if (owner.token === token) await rm(lockPath, cleanupOptions);
      } catch {
        console.error("Cache lock cleanup failed; retry ingest_board to recover a stopped local writer.");
      }
    }
  } finally {
    await rm(temporary, cleanupOptions).catch(() => console.error("Cache owner temporary file cleanup deferred."));
  }
}

async function reclaimAbandonedLock(lockPath: string): Promise<"retired" | "held" | "missing" | NodeJS.ErrnoException> {
  try {
    const directory = await stat(lockPath);
    let abandoned = Date.now() - directory.mtimeMs > 600_000;
    if (!abandoned) {
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown; hostname?: unknown };
        if ((owner.hostname === undefined || owner.hostname === hostname()) && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
          try { process.kill(owner.pid as number, 0); } catch (error) { abandoned = code(error) === "ESRCH"; }
        }
      } catch (error) {
        if (isTransientLockError(code(error))) throw error;
        // A missing owner can be the small window between mkdir and owner publication.
        abandoned = code(error) === "ENOENT" && Date.now() - directory.mtimeMs > 30_000;
      }
    }
    if (!abandoned) return "held";
    // Every observer of this directory uses the same destination. Keep it nonempty:
    // a late contender must fail rather than rename a newly acquired writer's lock.
    const identity = createHash("sha256").update(JSON.stringify([directory.dev, directory.ino, directory.birthtimeMs])).digest("hex");
    const retired = `${lockPath}-${identity}.retired`;
    await writeFile(path.join(lockPath, ".retired"), "", { flag: "a", mode: 0o600 });
    try { await rename(lockPath, retired); return "retired"; } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) return "held";
      throw error;
    }
  } catch (error) {
    const failure = code(error);
    if (failure === "ENOENT") return "missing";
    if (failure === "EBUSY") return "held";
    if ((failure === "EACCES" || failure === "EPERM") && error instanceof Error) {
      const permissionError = error as NodeJS.ErrnoException;
      permissionError.path ??= lockPath;
      return permissionError;
    }
    throw error;
  }
}
function isTransientLockError(failure: string | undefined): boolean {
  return failure === "EPERM" || failure === "EACCES" || failure === "EBUSY";
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code; }
