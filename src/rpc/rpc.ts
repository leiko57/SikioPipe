import type { Connection } from "../endpoint/connection.js";
import { MessageKind } from "../protocol/kinds.js";
import { defaultCodec, type Codec } from "./codec.js";
import { STREAM_REF_KEY, StreamReceiver, StreamSender, isStreamRef, makeStreamRef } from "./stream.js";

export type RpcOptions = {
  codec?: Codec;
  streamWindow?: number;
  callTimeoutMs?: number;
};

type CallOptions = {
  signal?: AbortSignal;
};

type RemoteReturn<R> = R extends AsyncIterable<infer T> ? AsyncIterable<T> : Promise<Awaited<R>>;

export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => RemoteReturn<R> : never;
};

export type RpcClient = {
  wrap<T>(): Remote<T>;
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

export function rpc(conn: Connection, opts: RpcOptions = {}): RpcClient & RpcServer {
  const core = new RpcCore(conn, opts);
  keepRpcCoreAlive(conn, core);
  return {
    wrap<T>() {
      return core.wrap<T>();
    },
    expose(impl: Record<string, unknown>) {
      core.expose(impl);
    },
    getStats() {
      return core.getStats();
    },
  };
}

const RPC_CORE_KEY: unique symbol = Symbol.for("sikiopipe:rpcCore") as any;

function keepRpcCoreAlive(conn: Connection, core: RpcCore) {
  const c = conn as any;
  const list: RpcCore[] = (c[RPC_CORE_KEY] ??= []);
  list.push(core);
}

class RpcCore {
  private readonly conn: Connection;
  private readonly codec: Codec;
  private readonly streamWindow: number;
  private readonly callTimeoutMs: number;
  private readonly sideBit: number;
  private callSeq = 1;
  private streamSeq = 1;
  private impl: Record<string, unknown> | null = null;

  private readonly pendingCalls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      signal?: AbortSignal;
      abortListener?: () => void;
      outboundStreamIds: number[];
      timeoutId?: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly activeCalls = new Map<number, AbortController>();
  private readonly inboundStreams = new Map<number, StreamReceiver>();
  private readonly outboundStreams = new Map<number, StreamSender>();

  constructor(conn: Connection, opts: RpcOptions) {
    this.conn = conn;
    this.codec = opts.codec ?? defaultCodec;
    this.streamWindow = opts.streamWindow ?? 8;
    this.callTimeoutMs = opts.callTimeoutMs ?? 0;
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
    const self = this;
    const proxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return undefined;
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) => self.call(prop, args);
        },
      },
    );
    return proxy as unknown as Remote<T>;
  }

  private call(method: string, args: unknown[]) {
    const { callArgs, callOptions } = splitCallOptions(args);
    const callId = this.nextCallId();
    const timeoutMs = this.callTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let signal = callOptions.signal;
    if (!signal && timeoutMs > 0) {
      const timeoutController = new AbortController();
      timeoutId = setTimeout(() => {
        timeoutController?.abort(new Error("RPC timeout"));
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
          .catch(() => undefined)
          .finally(() => {
            this.outboundStreams.delete(streamId);
          });
        return makeStreamRef(streamId);
      }
      return a;
    });

    const payload = this.codec.encode({ method, args: transformedArgs });
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingCalls.set(callId, {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(timeoutId ? { timeoutId } : {}),
        outboundStreamIds,
      });
    });

    if (signal) {
      const rec = this.pendingCalls.get(callId)!;
      const abortListener = () => {
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
      .catch((e) => {
        const rec = this.pendingCalls.get(callId);
        if (!rec) return;
        this.pendingCalls.delete(callId);
        rec.abortListener && rec.signal?.removeEventListener("abort", rec.abortListener);
        if (rec.timeoutId) clearTimeout(rec.timeoutId);
        rec.reject(e);
      });

    return new RpcCallResult(promise, this, signal);
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
    const self = this;
    return (async function* () {
      try {
        yield* recv.iter(signal ? { signal } : undefined);
      } finally {
        recv.cancel();
        self.inboundStreams.delete(streamId);
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
      .catch(() => undefined);
  }

  private async loopResolve() {
    try {
      for await (const frame of this.conn.router.recv(MessageKind.RpcResolve)) {
        try {
          const rec = this.pendingCalls.get(frame.id);
          const value = this.codec.decode(frame.payload);
          if (!rec) continue;
          this.pendingCalls.delete(frame.id);
          rec.abortListener && rec.signal?.removeEventListener("abort", rec.abortListener);
          if (rec.timeoutId) clearTimeout(rec.timeoutId);
          rec.resolve(value);
        } catch (e) {
          const rec = this.pendingCalls.get(frame.id);
          if (rec) {
            this.pendingCalls.delete(frame.id);
            if (rec.timeoutId) clearTimeout(rec.timeoutId);
            rec.reject(e);
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
        try {
          const rec = this.pendingCalls.get(frame.id);
          const value = this.codec.decode(frame.payload);
          if (!rec) continue;
          this.pendingCalls.delete(frame.id);
          rec.abortListener && rec.signal?.removeEventListener("abort", rec.abortListener);
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
          const msg = this.codec.decode(frame.payload) as any;
          const method = String(msg?.method ?? "");
          const rawArgs = Array.isArray(msg?.args) ? msg.args : [];
          const args = rawArgs.map((a: unknown) => {
            if (isStreamRef(a)) {
              const streamId = (a as any)[STREAM_REF_KEY] as number;
              return this.openInboundStream(streamId, controller.signal);
            }
            return a;
          });
          const impl = this.impl;
          if (!impl) throw new Error("No RPC implementation");
          const fn = (impl as any)[method];
          if (typeof fn !== "function") throw new Error(`Unknown method: ${method}`);
          const result = fn(...args, { signal: controller.signal });

          if (isAsyncIterableOfUint8(result)) {
            const streamId = this.nextStreamId();
            const sender = new StreamSender(this.conn.router, this.codec, streamId);
            this.outboundStreams.set(streamId, sender);
            void sender
              .start(result, { signal: controller.signal })
              .catch(() => undefined)
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
        } catch (e) {
          const payload = this.codec.encode(serializeError(e));
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

class RpcCallResult<T> implements Promise<T>, AsyncIterable<Uint8Array> {
  readonly [Symbol.toStringTag] = "RpcCallResult";
  private readonly promise: Promise<T>;
  private readonly core: RpcCore;
  private readonly signal: AbortSignal | undefined;
  private aborted = false;
  private cancelSent = false;
  private cancelScheduled = false;
  private streamId: number | null = null;

  constructor(promise: Promise<any>, core: RpcCore, signal?: AbortSignal) {
    this.promise = promise;
    this.core = core;
    this.signal = signal;
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
      .then((value: any) => {
        if (!this.aborted || this.cancelSent) return;
        if (!isStreamRef(value)) return;
        const streamId = value[STREAM_REF_KEY] as number;
        this.streamId = streamId;
        this.cancelStream(streamId);
      })
      .catch(() => undefined);
  }

  private cancelStream(streamId: number) {
    if (this.cancelSent) return;
    this.cancelSent = true;
    this.core.cancelInboundStream(streamId);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled as any, onrejected as any);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined,
  ): Promise<T | TResult> {
    return this.promise.catch(onrejected as any);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.promise.finally(onfinally as any);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const signal = this.signal;
    let inner: AsyncIterator<Uint8Array> | null = null;
    let init: Promise<AsyncIterator<Uint8Array>> | null = null;

    const getInner = async () => {
      if (inner) return inner;
      if (!init) {
        init = (async () => {
          const value: any = await this.promise;
          if (!isStreamRef(value)) throw new TypeError("RPC result is not a stream");
          const streamId = value[STREAM_REF_KEY] as number;
          this.streamId = streamId;
          if (this.aborted) {
            this.cancelStream(streamId);
            throw new DOMException("Aborted", "AbortError");
          }
          inner = this.core.openInboundStream(streamId, signal)[Symbol.asyncIterator]();
          return inner;
        })();
      }
      return await init;
    };

    const abortNow = async (): Promise<never> => {
      this.markAborted();
      if (inner && typeof inner.return === "function") {
        void inner.return(undefined as any).catch(() => undefined);
      }
      throw new DOMException("Aborted", "AbortError");
    };

    const selfIterator: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
      async next() {
        if (signal?.aborted) return await abortNow();
        const it = await getInner();
        if (signal?.aborted) return await abortNow();
        return await it.next();
      },
      async return(value?: any) {
        const it = await getInner().catch(() => null);
        if (it && typeof it.return === "function") return await it.return(value);
        return { done: true, value } as IteratorReturnResult<Uint8Array>;
      },
      async throw(err?: any) {
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
  if (typeof last === "object" && last !== null && "signal" in (last as any)) {
    const signal = (last as any).signal;
    if (signal instanceof AbortSignal) {
      return { callArgs: args.slice(0, -1), callOptions: { signal } };
    }
  }
  return { callArgs: args, callOptions: {} };
}

function isAsyncIterableOfUint8(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && typeof (value as any)[Symbol.asyncIterator] === "function";
}

function serializeError(err: unknown) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack ?? "" };
  if (typeof err === "object" && err !== null) {
    const name = typeof (err as any).name === "string" ? (err as any).name : "Error";
    const message = typeof (err as any).message === "string" ? (err as any).message : String(err);
    const stack = typeof (err as any).stack === "string" ? (err as any).stack : "";
    return { name, message, stack };
  }
  return { name: "Error", message: String(err), stack: "" };
}

function toError(value: unknown) {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null) {
    const name = typeof (value as any).name === "string" ? (value as any).name : "Error";
    const message = typeof (value as any).message === "string" ? (value as any).message : JSON.stringify(value);
    const e = new Error(message);
    e.name = name;
    if (typeof (value as any).stack === "string") e.stack = (value as any).stack;
    return e;
  }
  return new Error(String(value));
}



