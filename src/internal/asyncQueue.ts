export class AsyncQueue<T> {
  private values: T[] = [];
  private head = 0;
  private readonly waiters: Array<{
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    signal?: AbortSignal;
    abortListener?: () => void;
  }> = [];
  private closedErr: Error | null = null;

  push(value: T) {
    if (this.closedErr) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.abortListener && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  shift(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.head < this.values.length) {
      const value = this.values[this.head];
      this.head += 1;
      this.compactValues();
      if (value !== undefined) return Promise.resolve(value);
    }
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number];
      if (signal) {
        const abortListener = () => {
          this.removeWaiter(waiter);
          reject(new DOMException("Aborted", "AbortError"));
        };
        waiter.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  close(err?: Error) {
    if (this.closedErr) return;
    this.closedErr = err ?? new Error("Closed");
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.abortListener && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.reject(this.closedErr);
    }
    this.values.length = 0;
    this.head = 0;
  }

  size() {
    return this.values.length - this.head;
  }

  stats() {
    return {
      size: this.values.length - this.head,
      waiters: this.waiters.length,
    };
  }

  drain(): T[] {
    const out = this.values.slice(this.head);
    this.values.length = 0;
    this.head = 0;
    return out;
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]) {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
    if (waiter.abortListener && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abortListener);
  }

  private compactValues() {
    if (this.head < 1024) return;
    if (this.head * 2 < this.values.length) return;
    this.values = this.values.slice(this.head);
    this.head = 0;
  }
}


