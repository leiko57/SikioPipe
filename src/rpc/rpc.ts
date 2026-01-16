import type { Connection } from "../endpoint/connection.js";
import { MessageKind } from "../protocol/kinds.js";
import { type Codec, defaultCodec } from "./codec.js";
import { type BorrowedStreamChunk, isStreamRef, makeStreamRef, STREAM_REF_KEY, StreamReceiver, StreamSender } from "./stream.js";

export type RpcOptions = {
  codec?: Codec;
  streamWindow?: number;
  callTimeoutMs?: number;
  streamBorrowed?: boolean;
};

type CallOptions = {
  signal?: AbortSignal;
};

type RemoteReturn<R> = R extends AsyncIterable<infer T> ? AsyncIterable<T> : Promise<Awaited<R>>;

export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => RemoteReturn<R> : never;
};

type RemoteBorrowedReturn<R> = R extends AsyncIterable<Uint8Array>
  ? AsyncIterable<BorrowedStreamChunk>
  : Promise<Awaited<R>>;

export type RemoteBorrowed<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => RemoteBorrowedReturn<R> : never;
};

export type RpcClient = {
  wrap<T>(): Remote<T>;
  wrapBorrowed<T>(): RemoteBorrowed<T>;
  getStats(): RpcStats;
};

export type RpcServer = {
  expose(impl: Record<string, unknown>): void;
};

export type RpcStats = {
  pendingCalls: number;
  activeCalls: number;
  inboundStreams: number;
  outboundStreams: number;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  outboundStreamIds: number[];
  timeoutId?: ReturnType<typeof setTimeout>;
};

export function rpc(conn: Connection, opts: RpcOptions = {}): RpcClient & RpcServer {
  const core = new RpcCore(conn, opts);
  keepRpcCoreAlive(conn, core);
  return {
    wrap<T>() {
      return core.wrap<T>();
    },
    wrapBorrowed<T>() {
      return core.wrapBorrowed<T>();
    },
    expose(impl: Record<string, unknown>) {
      core.expose(impl);
    },
    getStats() {
      return core.getStats();
    },
  };
}

const RPC_CORE_KEY = Symbol.for("sikiopipe:rpcCore");

type RpcCoreHolder = {
  [key: symbol]: RpcCore[] | undefined;
};

function keepRpcCoreAlive(conn: Connection, core: RpcCore) {
  const holder = conn as Connection & RpcCoreHolder;
  let list = holder[RPC_CORE_KEY];
  if (!list) {
    list = [];
    holder[RPC_CORE_KEY] = list;
  }
  list.push(core);
}

class RpcCore {
  private readonly conn: Connection;
  private readonly codec: Codec;
  private readonly streamWindow: number;
  private readonly callTimeoutMs: number;
  private readonly inboundBorrowed: boolean;
  private readonly sideBit: number;
  private callSeq = 1;
  private streamSeq = 1;
  private impl: Record<string, unknown> | null = null;

  private readonly pendingCalls = new Map<number, PendingCall>();

  private readonly activeCalls = new Map<number, AbortController>();
  private readonly inboundStreams = new Map<number, StreamReceiver>();
  private readonly outboundStreams = new Map<number, StreamSender>();

  constructor(conn: Connection, opts: RpcOptions) {
    this.conn = conn;
    this.codec = opts.codec ?? defaultCodec;
    this.streamWindow = opts.streamWindow ?? 8;
    this.callTimeoutMs = opts.callTimeoutMs ?? 0;
    this.inboundBorrowed = opts.streamBorrowed ?? false;
    this.sideBit = conn.role === "client" ? 0 : 1;
    void this.loopCalls();
    void this.loopResolve();
    void this.loopReject();
    void this.loopCancel();
    void this.loopStreamPush();
    void this.loopStreamEnd();
    void this.loopStreamCredit();
    void this.loopStreamCancel();
  }

  expose(impl: Record<string, unknown>) {
    this.impl = impl;
  }

  getStats(): RpcStats {
    return {
      pendingCalls: this.pendingCalls.size,
      activeCalls: this.activeCalls.size,
      inboundStreams: this.inboundStreams.size,
      outboundStreams: this.outboundStreams.size,
    };
  }

  wrap<T>(): Remote<T> {
    return this.wrapInternal(false) as Remote<T>;
  }

  wrapBorrowed<T>(): RemoteBorrowed<T> {
    return this.wrapInternal(true) as RemoteBorrowed<T>;
  }

  private wrapInternal(borrowed: boolean) {
    const proxy = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "then") return undefined;
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) => this.call(prop, args, borrowed);
        },
      },
    );
    return proxy;
  }

  private call<TBorrowed extends boolean>(method: string, args: unknown[], borrowed: TBorrowed) {
    const { callArgs, callOptions } = splitCallOptions(args);
    const callId = this.nextCallId();
    const timeoutMs = this.callTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let signal = callOptions.signal;
    if (!signal && timeoutMs > 0) {
      const timeoutController = new AbortController();
      timeoutId = setTimeout(() => {
        timeoutController.abort(new Error("RPC timeout"));
      }, timeoutMs);
      signal = timeoutController.signal;
    }
    const outboundStreamIds: number[] = [];
    const transformedArgs = callArgs.map((a) => {
      if (isAsyncIterableOfUint8(a)) {
        const streamId = this.nextStreamId();
        outboundStreamIds.push(streamId);
        const sender = new StreamSender(this.conn.router, this.codec, streamId);
        this.outboundStreams.set(streamId, sender);
        void sender
          .start(a, signal ? { signal } : undefined)
          .catch(() => {
            return undefined;
          })
          .finally(() => {
            this.outboundStreams.delete(streamId);
          });
        return makeStreamRef(streamId);
      }
      return a;
    });

    const payload = this.codec.encode({ method, args: transformedArgs });
    const promise = new Promise<unknown>((resolve, reject) => {
      const record: PendingCall = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(timeoutId ? { timeoutId } : {}),
        outboundStreamIds,
      };
      this.pendingCalls.set(callId, record);
    });

    if (signal) {
      const abortListener = () => {
        const rec = this.pendingCalls.get(callId);
        if (!rec) return;
        this.pendingCalls.delete(callId);
        void this.conn.router.send({
          kind: MessageKind.RpcCancel,
          id: callId,
          streamId: 0,
          flags: 0,
          aux: 0,
          payload: new Uint8Array(0),
        });
        for (const sid of outboundStreamIds) {
          this.outboundStreams.get(sid)?.cancelFromRemote();
          void this.conn.router.send({
            kind: MessageKind.StreamCancel,
            id: 0,
            streamId: sid,
            flags: 0,
            aux: 0,
            payload: new Uint8Array(0),
          });
        }
        if (rec.timeoutId) clearTimeout(rec.timeoutId);
        rec.reject(rec.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const rec = this.pendingCalls.get(callId);
      if (!rec) throw new Error("Pending call missing");
      rec.abortListener = abortListener;
      signal.addEventListener("abort", abortListener, { once: true });
    }

    void this.conn.router
      .send(
        {
          kind: MessageKind.RpcCall,
          id: callId,
          streamId: 0,
          flags: 0,
          aux: 0,
          payload,
        },
        signal ? { signal } : undefined,
      )
      .catch((e: unknown) => {
        const rec = this.pendingCalls.get(callId);
        if (!rec) return;
        this.pendingCalls.delete(callId);
        if (rec.abortListener && rec.signal) {
          rec.signal.removeEventListener("abort", rec.abortListener);
        }
        if (rec.timeoutId) clearTimeout(rec.timeoutId);
        rec.reject(e);
      });

    return new RpcCallResult(promise, this, signal, borrowed);
  }

  private nextCallId() {
    const id = ((this.callSeq++ << 1) | this.sideBit) >>> 0;
    return id;
  }

  private nextStreamId() {
    const id = ((this.streamSeq++ << 1) | this.sideBit) >>> 0;
    return id;
  }

  openInboundStream(streamId: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const existing = this.inboundStreams.get(streamId);
    if (existing) return existing.iter(signal ? { signal } : undefined);
    const recv = new StreamReceiver(this.conn.router, this.codec, streamId, this.streamWindow);
    this.inboundStreams.set(streamId, recv);
    recv.start();
    const inboundStreams = this.inboundStreams;
    return (async function* () {
      try {
        yield* recv.iter(signal ? { signal } : undefined);
      } finally {
        recv.cancel();
        inboundStreams.delete(streamId);
      }
    })();
  }

  openInboundStreamBorrowed(streamId: number, signal?: AbortSignal): AsyncIterable<BorrowedStreamChunk> {
    const existing = this.inboundStreams.get(streamId);
    if (existing) return existing.iterBorrowed(signal ? { signal } : undefined);
    const recv = new StreamReceiver(this.conn.router, this.codec, streamId, this.streamWindow);
    this.inboundStreams.set(streamId, recv);
    recv.start();
    const inboundStreams = this.inboundStreams;
    return (async function* () {
      try {
        yield* recv.iterBorrowed(signal ? { signal } : undefined);
      } finally {
        recv.cancel();
        inboundStreams.delete(streamId);
      }
    })();
  }

  cancelInboundStream(streamId: number) {
    const id = streamId >>> 0;
    const recv = this.inboundStreams.get(id);
    if (recv) {
      recv.cancel();
      this.inboundStreams.delete(id);
      return;
    }
    void this.conn.router
      .send({
        kind: MessageKind.StreamCancel,
        id: 0,
        streamId: id,
        flags: 0,
        aux: 0,
        payload: new Uint8Array(0),
      })
      .catch(() => {
        return undefined;
      });
  }

  private async loopResolve() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.RpcResolve)) {
        try {
          const rec = this.pendingCalls.get(frame.id);
          const value = this.codec.decode(frame.payload);
          if (!rec) continue;
          this.pendingCalls.delete(frame.id);
          if (rec.abortListener && rec.signal) {
            rec.signal.removeEventListener("abort", rec.abortListener);
          }
          if (rec.timeoutId) clearTimeout(rec.timeoutId);
          rec.resolve(value);
        } catch (err) {
          const rec = this.pendingCalls.get(frame.id);
          if (rec) {
            this.pendingCalls.delete(frame.id);
            if (rec.timeoutId) clearTimeout(rec.timeoutId);
            rec.reject(err);
          }
        } finally {
          frame.release();
        }
      }
    } catch {
      return;
    }
  }

  private async loopReject() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.RpcReject)) {
        const rec = this.pendingCalls.get(frame.id);
        try {
          if (!rec) continue;
          let value: unknown;
          try {
            value = this.codec.decode(frame.payload);
          } catch (err) {
            this.pendingCalls.delete(frame.id);
            if (rec.abortListener && rec.signal) {
              rec.signal.removeEventListener("abort", rec.abortListener);
            }
            if (rec.timeoutId) clearTimeout(rec.timeoutId);
            rec.reject(toError(err));
            continue;
          }
          this.pendingCalls.delete(frame.id);
          if (rec.abortListener && rec.signal) {
            rec.signal.removeEventListener("abort", rec.abortListener);
          }
          if (rec.timeoutId) clearTimeout(rec.timeoutId);
          rec.reject(toError(value));
        } finally {
          frame.release();
        }
      }
    } catch {
      return;
    }
  }

  private async loopCancel() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.RpcCancel)) {
        try {
          const controller = this.activeCalls.get(frame.id);
          controller?.abort();
        } finally {
          frame.release();
        }
      }
    } catch {
      return;
    }
  }

  private async loopCalls() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.RpcCall)) {
        const callId = frame.id;
        const controller = new AbortController();
        this.activeCalls.set(callId, controller);
        try {
          const msg = this.codec.decode(frame.payload);
          const msgRecord = isRecord(msg) ? msg : {};
          const methodValue = msgRecord.method;
          const method =
            typeof methodValue === "string" ||
            typeof methodValue === "number" ||
            typeof methodValue === "boolean" ||
            typeof methodValue === "bigint" ||
            typeof methodValue === "symbol"
              ? String(methodValue)
              : "";
          const rawArgsValue = msgRecord.args;
          const rawArgs = isUnknownArray(rawArgsValue) ? rawArgsValue : [];
          const args = rawArgs.map((a) => {
            if (isStreamRef(a)) {
              const streamId = a[STREAM_REF_KEY];
              return this.inboundBorrowed
                ? this.openInboundStreamBorrowed(streamId, controller.signal)
                : this.openInboundStream(streamId, controller.signal);
            }
            return a;
          });
          const impl = this.impl;
          if (!impl) throw new Error("No RPC implementation");
          const fn = impl[method];
          if (typeof fn !== "function") throw new Error(`Unknown method: ${method}`);
          const result = (fn as (...args: unknown[]) => unknown)(...args, { signal: controller.signal });

          if (isAsyncIterableOfUint8(result)) {
            const streamId = this.nextStreamId();
            const sender = new StreamSender(this.conn.router, this.codec, streamId);
            this.outboundStreams.set(streamId, sender);
            void sender
              .start(result, { signal: controller.signal })
              .catch(() => {
                return undefined;
              })
              .finally(() => {
                this.outboundStreams.delete(streamId);
              });
            const payload = this.codec.encode(makeStreamRef(streamId));
            await this.conn.router.send({
              kind: MessageKind.RpcResolve,
              id: callId,
              streamId: 0,
              flags: 0,
              aux: 0,
              payload,
            });
            continue;
          }

          const value = await Promise.resolve(result);
          const payload = this.codec.encode(value);
          await this.conn.router.send({
            kind: MessageKind.RpcResolve,
            id: callId,
            streamId: 0,
            flags: 0,
            aux: 0,
            payload,
          });
        } catch (err) {
          const payload = this.codec.encode(serializeError(err));
          await this.conn.router.send({
            kind: MessageKind.RpcReject,
            id: callId,
            streamId: 0,
            flags: 0,
            aux: 0,
            payload,
          });
        } finally {
          this.activeCalls.delete(callId);
          frame.release();
        }
      }
    } catch {
      return;
    }
  }

  private async loopStreamPush() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.StreamPush)) {
        const recv = this.inboundStreams.get(frame.streamId);
        if (!recv) {
          frame.release();
          continue;
        }
        recv.push(frame);
      }
    } catch {
      return;
    }
  }

  private async loopStreamEnd() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.StreamEnd)) {
        const recv = this.inboundStreams.get(frame.streamId);
        if (!recv) {
          frame.release();
          continue;
        }
        recv.push(frame);
      }
    } catch {
      return;
    }
  }

  private async loopStreamCredit() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.StreamCredit)) {
        try {
          const sender = this.outboundStreams.get(frame.streamId);
          sender?.onCredit(frame.aux);
        } finally {
          frame.release();
        }
      }
    } catch {
      return;
    }
  }

  private async loopStreamCancel() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.StreamCancel)) {
        try {
          const sender = this.outboundStreams.get(frame.streamId);
          sender?.cancelFromRemote();
        } finally {
          frame.release();
        }
      }
    } catch {
      return;
    }
  }
}

class RpcCallResult<T, B extends boolean>
  implements Promise<T>, AsyncIterable<B extends true ? BorrowedStreamChunk : Uint8Array>
{
  readonly [Symbol.toStringTag] = "RpcCallResult";
  private readonly promise: Promise<T>;
  private readonly core: RpcCore;
  private readonly signal: AbortSignal | undefined;
  private readonly borrowed: B;
  private aborted = false;
  private cancelSent = false;
  private cancelScheduled = false;
  private streamId: number | null = null;

  constructor(promise: Promise<T>, core: RpcCore, signal: AbortSignal | undefined, borrowed: B) {
    this.promise = promise;
    this.core = core;
    this.signal = signal;
    this.borrowed = borrowed;
    if (this.signal) {
      this.signal.addEventListener(
        "abort",
        () => {
          this.markAborted();
        },
        { once: true },
      );
    }
  }

  private markAborted() {
    if (this.aborted) return;
    this.aborted = true;
    if (this.streamId !== null) {
      this.cancelStream(this.streamId);
      return;
    }
    if (this.cancelScheduled) return;
    this.cancelScheduled = true;
    void this.promise
      .then((value) => {
        if (!this.aborted || this.cancelSent) return;
        if (!isStreamRef(value)) return;
        const streamId = value[STREAM_REF_KEY];
        this.streamId = streamId;
        this.cancelStream(streamId);
      })
      .catch(() => {
        return undefined;
      });
  }

  private cancelStream(streamId: number) {
    if (this.cancelSent) return;
    this.cancelSent = true;
    this.core.cancelInboundStream(streamId);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.promise.finally(onfinally);
  }

  [Symbol.asyncIterator](): AsyncIterator<B extends true ? BorrowedStreamChunk : Uint8Array> {
    const signal = this.signal;
    let inner: AsyncIterator<B extends true ? BorrowedStreamChunk : Uint8Array> | null = null;
    let init: Promise<AsyncIterator<B extends true ? BorrowedStreamChunk : Uint8Array>> | null = null;

    const getInner = async () => {
      if (inner) return inner;
      if (!init) {
        init = (async () => {
          const value = await this.promise;
          if (!isStreamRef(value)) throw new TypeError("RPC result is not a stream");
          const streamId = value[STREAM_REF_KEY];
          this.streamId = streamId;
          if (this.aborted) {
            this.cancelStream(streamId);
            throw new DOMException("Aborted", "AbortError");
          }
          inner = (this.borrowed
            ? this.core.openInboundStreamBorrowed(streamId, signal)
            : this.core.openInboundStream(streamId, signal))[Symbol.asyncIterator]() as AsyncIterator<
            B extends true ? BorrowedStreamChunk : Uint8Array
          >;
          return inner;
        })();
      }
      return await init;
    };

    const abortNow = (): Promise<never> => {
      this.markAborted();
      if (inner && typeof inner.return === "function") {
        void inner.return(undefined).catch(() => {
          return undefined;
        });
      }
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    };

    const selfIterator: AsyncIterator<B extends true ? BorrowedStreamChunk : Uint8Array> &
      AsyncIterable<B extends true ? BorrowedStreamChunk : Uint8Array> = {
      async next() {
        if (signal?.aborted) return await abortNow();
        const it = await getInner();
        if (signal?.aborted) return await abortNow();
        return await it.next();
      },
      async return(value?: B extends true ? BorrowedStreamChunk : Uint8Array) {
        const it = await getInner().catch(() => null);
        if (it && typeof it.return === "function") return await it.return(value);
        return { done: true, value } as IteratorReturnResult<B extends true ? BorrowedStreamChunk : Uint8Array>;
      },
      async throw(err?: unknown) {
        const it = await getInner().catch(() => null);
        if (it && typeof it.throw === "function") return await it.throw(err);
        throw err;
      },
      [Symbol.asyncIterator]() {
        return selfIterator;
      },
    };

    return selfIterator;
  }
}

function splitCallOptions(args: unknown[]): { callArgs: unknown[]; callOptions: CallOptions } {
  if (args.length === 0) return { callArgs: args, callOptions: {} };
  const last = args[args.length - 1];
  const signal = getAbortSignal(last);
  if (signal) {
    return { callArgs: args.slice(0, -1), callOptions: { signal } };
  }
  return { callArgs: args, callOptions: {} };
}

function isAsyncIterableOfUint8(value: unknown): value is AsyncIterable<Uint8Array> {
  if (!isRecord(value)) return false;
  const iterator = value[Symbol.asyncIterator];
  return typeof iterator === "function";
}

function serializeError(err: unknown) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack ?? "" };
  if (isRecord(err)) {
    const name = typeof err.name === "string" ? err.name : "Error";
    const message = typeof err.message === "string" ? err.message : stringifyValue(err);
    const stack = typeof err.stack === "string" ? err.stack : "";
    return { name, message, stack };
  }
  return { name: "Error", message: stringifyValue(err), stack: "" };
}

function toError(value: unknown) {
  if (value instanceof Error) return value;
  if (isRecord(value)) {
    const name = typeof value.name === "string" ? value.name : "Error";
    const message = typeof value.message === "string" ? value.message : stringifyValue(value);
    const e = new Error(message);
    e.name = name;
    if (typeof value.stack === "string") e.stack = value.stack;
    return e;
  }
  return new Error(stringifyValue(value));
}

function getAbortSignal(value: unknown): AbortSignal | null {
  if (!isRecord(value)) return null;
  const signal = value.signal;
  return signal instanceof AbortSignal ? signal : null;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return value.name ? `function ${value.name}` : "function";
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}



