import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { resizeToJpeg, type ResizableFormat } from "./imageResize.js";

/**
 * Decoding and scaling a large image takes seconds of CPU. One worker thread
 * does it, one image after another, so the main thread keeps answering MCP
 * requests and cancellation. This file is both the client and the worker.
 */
const WORKER_ROLE = "figjam-image-resize";

interface ResizeRequest { data: Uint8Array; format: ResizableFormat }
type ResizeReply = { data: Uint8Array } | { error: string };

if (!isMainThread && workerData === WORKER_ROLE) {
  parentPort!.on("message", ({ data, format }: ResizeRequest) => {
    let reply: ResizeReply;
    try { reply = { data: new Uint8Array(resizeToJpeg(data, format)) }; }
    catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; }
    parentPort!.postMessage(reply, "data" in reply ? [reply.data.buffer as ArrayBuffer] : []);
  });
}

export class ImageResizeError extends Error {
  constructor(message: string) { super(message); this.name = "ImageResizeError"; }
}

let worker: Worker | undefined;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Resizes one image on the worker thread after the images queued before it.
 * An aborted signal rejects at once with its reason and stops the worker if it
 * is working on this image; the next image starts a new one.
 */
export function resizeInWorker(data: Uint8Array, format: ResizableFormat, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const job = queue.then(() => runJob(data, format, signal));
  queue = job.catch(() => undefined);
  if (!signal) return job;
  return new Promise<Buffer>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function runJob(data: Uint8Array, format: ResizableFormat, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const current = worker ??= startWorker();
  current.ref();
  return new Promise<Buffer>((resolve, reject) => {
    const settle = (stop: boolean) => {
      current.off("message", onMessage).off("error", onFailure).off("exit", onFailure);
      signal?.removeEventListener("abort", onAbort);
      if (stop) {
        if (worker === current) worker = undefined;
        void current.terminate();
      } else current.unref();
    };
    const onMessage = (reply: ResizeReply) => {
      settle(false);
      if ("data" in reply) resolve(Buffer.from(reply.data.buffer, reply.data.byteOffset, reply.data.byteLength));
      else reject(new ImageResizeError(reply.error));
    };
    const onFailure = () => { settle(true); reject(new ImageResizeError("The image worker stopped")); };
    const onAbort = () => { settle(true); reject(signal!.reason); };
    current.on("message", onMessage).on("error", onFailure).on("exit", onFailure);
    signal?.addEventListener("abort", onAbort, { once: true });
    // A copy owns its memory, so it can move to the worker without touching pooled buffers.
    const copy = new Uint8Array(data);
    current.postMessage({ data: copy, format } satisfies ResizeRequest, [copy.buffer]);
  });
}

function startWorker(): Worker {
  const started = new Worker(new URL(import.meta.url), { workerData: WORKER_ROLE });
  // An idle worker that fails or exits is replaced by the next image; its error must not reach the process.
  const forget = () => { if (worker === started) worker = undefined; };
  started.on("error", forget).on("exit", forget);
  started.unref();
  return started;
}
