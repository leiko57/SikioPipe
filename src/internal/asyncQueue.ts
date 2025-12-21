export class AsyncQueue<T> {
  private readonly values: T[] = [];
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
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
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
  }

  size() {
    return this.values.length;
  }

  stats() {
    return {
      size: this.values.length,
      waiters: this.waiters.length,
    };
  }

  drain(): T[] {
    return this.values.splice(0);
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]) {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
    if (waiter.abortListener && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abortListener);
  }
}


