import { Worker } from "node:worker_threads";
import { connectToWorkerLike } from "../endpoint/connection.js";
import type { SpawnWorkerOptions } from "./spawnWorker.shared.js";

export type { SpawnWorkerOptions } from "./spawnWorker.shared.js";

export async function spawnWorker(url: URL, opts: SpawnWorkerOptions = {}) {
  const worker = new Worker(url, { type: "module" });
  const conn = await connectToWorkerLike(worker, opts);
  return Object.assign(conn, {
    worker,
    terminate: () => worker.terminate(),
  });
}

