import { abortPromise, throwIfAborted } from "../internal/abort.js";

type AtomicsWithWaitAsync = typeof Atomics & { waitAsync?: (...args: unknown[]) => { value: Promise<string> | string } };

const supportsBlockingWait = typeof Atomics !== "undefined" && typeof Atomics.wait === "function";
const isBrowserWorker =
  typeof self !== "undefined" &&
  typeof (self as { postMessage?: unknown }).postMessage === "function" &&
  typeof (self as { document?: unknown }).document === "undefined";
const isNodeLike = typeof process !== "undefined" && typeof process.versions.node === "string";
let useBlockingWait = supportsBlockingWait && isBrowserWorker;

if (supportsBlockingWait && isNodeLike) {
  void import("node:worker_threads")
    .then((mod) => {
      if (!mod.isMainThread) useBlockingWait = true;
    })
    .catch(() => {
      return undefined;
    });
}

const waitTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitOn(meta: Int32Array, index: number, value: number, signal?: AbortSignal) {
  if (useBlockingWait && !signal && supportsBlockingWait) {
    Atomics.wait(meta, index, value);
    return;
  }
  const waitAsync = (Atomics as AtomicsWithWaitAsync).waitAsync;
  if (typeof waitAsync === "function") {
    const wait = waitAsync(meta, index, value);
    await (signal ? Promise.race([wait.value, abortPromise(signal)]) : wait.value);
    return;
  }
  if (signal) {
    await Promise.race([waitTick(), abortPromise(signal)]);
    return;
  }
  await waitTick();
}

export class SpscRing {
  readonly capacity: number;
  private readonly mask: number;
  private readonly meta: Int32Array;
  private readonly data: Int32Array;
  private closed = false;

  static allocate(capacity: number) {
    const cap = normalizeCapacity(capacity);
    return new SharedArrayBuffer(8 + cap * 4);
  }

  constructor(sab: SharedArrayBuffer, capacity: number) {
    const cap = normalizeCapacity(capacity);
    if (sab.byteLength < 8 + cap * 4) throw new RangeError("Invalid ring buffer");
    this.capacity = cap;
    this.mask = cap - 1;
    this.meta = new Int32Array(sab, 0, 2);
    this.data = new Int32Array(sab, 8, cap);
  }

  initFilled(count: number, fill: (index: number) => number) {
    const c = Math.min(count, this.capacity);
    for (let i = 0; i < c; i++) this.data[i] = fill(i) | 0;
    Atomics.store(this.meta, 0, c | 0);
    Atomics.store(this.meta, 1, 0);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    Atomics.notify(this.meta, 0);
    Atomics.notify(this.meta, 1);
  }

  count() {
    const w = Atomics.load(this.meta, 0) >>> 0;
    const r = Atomics.load(this.meta, 1) >>> 0;
    return (w - r) >>> 0;
  }

  state() {
    const w = Atomics.load(this.meta, 0) >>> 0;
    const r = Atomics.load(this.meta, 1) >>> 0;
    return { w, r, count: (w - r) >>> 0 };
  }

  pushSync(value: number) {
    if (this.closed) return;
    const w = Atomics.load(this.meta, 0) >>> 0;
    const r = Atomics.load(this.meta, 1) >>> 0;
    if (((w - r) >>> 0) >= this.capacity) throw new Error("Ring is full");
    this.data[w & this.mask] = value | 0;
    Atomics.store(this.meta, 0, (w + 1) | 0);
    Atomics.notify(this.meta, 0, 1);
  }

  async push(value: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.closed) throw new Error("Closed");
      throwIfAborted(signal);
      const w = Atomics.load(this.meta, 0) >>> 0;
      const r = Atomics.load(this.meta, 1) >>> 0;
      if (((w - r) >>> 0) < this.capacity) {
        this.data[w & this.mask] = value | 0;
        Atomics.store(this.meta, 0, (w + 1) | 0);
        Atomics.notify(this.meta, 0, 1);
        return;
      }
      await waitOn(this.meta, 1, r | 0, signal);
    }
  }

  async pop(signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (this.closed) throw new Error("Closed");
      throwIfAborted(signal);
      const w = Atomics.load(this.meta, 0) >>> 0;
      const r = Atomics.load(this.meta, 1) >>> 0;
      if (w !== r) {
        const value = this.data[r & this.mask];
        if (value === undefined) throw new Error("Ring read failed");
        Atomics.store(this.meta, 1, (r + 1) | 0);
        Atomics.notify(this.meta, 1, 1);
        return value | 0;
      }
      await waitOn(this.meta, 0, w | 0, signal);
    }
  }
}

function normalizeCapacity(capacity: number) {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("Invalid capacity");
  if ((capacity & (capacity - 1)) !== 0) throw new RangeError("Capacity must be a power of two");
  return capacity;
}


