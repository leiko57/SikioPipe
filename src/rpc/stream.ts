import type { FrameRouter } from "../endpoint/router.js";
import { abortError, abortPromise, throwIfAborted } from "../internal/abort.js";
import { AsyncQueue } from "../internal/asyncQueue.js";
import { MessageKind } from "../protocol/kinds.js";
import type { IncomingFrame } from "../transport/createTransport.js";
import type { Codec } from "./codec.js";

export const STREAM_REF_KEY = "__sikiopipe_stream__" as const;
export const STREAM_REF_TAG = "__sikiopipe_stream_tag__" as const;
const STREAM_REF_TAG_VALUE = 1;

export type StreamRef = {
  [STREAM_REF_KEY]: number;
  [STREAM_REF_TAG]?: number;
};

export type BorrowedStreamChunk = {
  readonly bytes: Uint8Array;
  release(): void;
};

export function makeStreamRef(id: number): StreamRef {
  return { [STREAM_REF_KEY]: id >>> 0, [STREAM_REF_TAG]: STREAM_REF_TAG_VALUE };
}

export function isStreamRef(value: unknown): value is StreamRef {
  if (!isRecord(value)) return false;
  const id = value[STREAM_REF_KEY];
  if (!Number.isInteger(id)) return false;
  const tag = value[STREAM_REF_TAG];
  if (tag === STREAM_REF_TAG_VALUE) return true;
  if (tag !== undefined) return false;
  return Object.keys(value).length === 1;
}

export class StreamSender {
  readonly streamId: number;
  private readonly router: FrameRouter;
  private readonly codec: Codec;
  private credits = 0;
  private creditWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private cancelled = false;

  constructor(router: FrameRouter, codec: Codec, streamId: number) {
    this.router = router;
    this.codec = codec;
    this.streamId = streamId >>> 0;
  }

  onCredit(delta: number) {
    if (this.cancelled) return;
    const d = delta >>> 0;
    if (d === 0) return;
    this.credits += d;
    if (this.credits > 0) this.signalCredit();
  }

  cancelFromRemote() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.signalCredit();
  }

  async start(source: AsyncIterable<Uint8Array>, opts?: { signal?: AbortSignal }) {
    const it = source[Symbol.asyncIterator]();
    let ended = false;
    try {
      for (;;) {
        throwIfAborted(opts?.signal);
        await this.waitForCredit(opts?.signal);
        if (this.cancelled) break;
        const next = await it.next();
        if (next.done) {
          ended = true;
          break;
        }
        this.credits -= 1;
        await this.router.send(
          {
            kind: MessageKind.StreamPush,
            id: 0,
            streamId: this.streamId,
            flags: 0,
            aux: 0,
            payload: next.value,
          },
          opts,
        );
      }
    } catch (err) {
      if (!this.cancelled) {
        const payload = this.codec.encode(serializeError(err));
        await this.router.send(
          {
            kind: MessageKind.StreamEnd,
            id: 0,
            streamId: this.streamId,
            flags: 0,
            aux: 1,
            payload,
          },
          opts,
        );
      }
      return;
    } finally {
      if (!ended && this.cancelled) {
        try {
          await it.return?.();
        } catch (err) {
          void err;
        }
      }
    }
    if (!this.cancelled) {
      await this.router.send(
        {
          kind: MessageKind.StreamEnd,
          id: 0,
          streamId: this.streamId,
          flags: 0,
          aux: 0,
          payload: new Uint8Array(0),
        },
        opts,
      );
    }
  }

  private async waitForCredit(signal?: AbortSignal) {
    while (this.credits <= 0 && !this.cancelled) {
      const waiter = this.getCreditWaiter();
      if (signal) {
        await Promise.race([waiter.promise, abortPromise(signal)]);
      } else {
        await waiter.promise;
      }
    }
  }

  private getCreditWaiter() {
    const existing = this.creditWaiter;
    if (existing) return existing;
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const waiter = { promise, resolve };
    this.creditWaiter = waiter;
    return waiter;
  }

  private signalCredit() {
    const waiter = this.creditWaiter;
    if (!waiter) return;
    this.creditWaiter = null;
    waiter.resolve();
  }
}

export class StreamReceiver {
  readonly streamId: number;
  private readonly router: FrameRouter;
  private readonly codec: Codec;
  private readonly creditInit: number;
  private readonly creditEach: number;
  private readonly q = new AsyncQueue<IncomingFrame>();
  private done = false;

  constructor(router: FrameRouter, codec: Codec, streamId: number, window: number) {
    this.router = router;
    this.codec = codec;
    this.streamId = streamId >>> 0;
    const normalized = window > 0 ? window >>> 0 : 0;
    this.creditInit = normalized === 0 ? 0xffffffff : normalized;
    this.creditEach = normalized === 0 ? 0 : 1;
  }

  start() {
    if (this.creditInit > 0) {
      void this.router
        .send({
          kind: MessageKind.StreamCredit,
          id: 0,
          streamId: this.streamId,
          flags: 0,
          aux: this.creditInit,
          payload: new Uint8Array(0),
        })
        .catch(() => {
          return undefined;
        });
    }
  }

  push(frame: IncomingFrame) {
    if (this.done) {
      frame.release();
      return;
    }
    this.q.push(frame);
  }

  async *iter(opts?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    const signal = opts?.signal;
    const abortListener = () => {
      this.cancel();
    };
    if (signal) signal.addEventListener("abort", abortListener, { once: true });
    try {
      for (;;) {
        const frame = await this.q.shift(signal);
        if (frame.kind === MessageKind.StreamEnd) {
          try {
            if ((frame.aux >>> 0) !== 0) {
              const err = this.codec.decode(frame.payload);
              throw toError(err);
            }
            return;
          } finally {
            frame.release();
            this.done = true;
          }
        }
        if (frame.kind !== MessageKind.StreamPush) {
          frame.release();
          continue;
        }
        const out = frame.payload.slice();
        frame.release();
        this.sendCredit();
        yield out;
      }
    } finally {
      if (signal) signal.removeEventListener("abort", abortListener);
    }
  }

  async *iterBorrowed(opts?: { signal?: AbortSignal }): AsyncIterable<BorrowedStreamChunk> {
    const signal = opts?.signal;
    const abortListener = () => {
      this.cancel();
    };
    if (signal) signal.addEventListener("abort", abortListener, { once: true });
    let currentRelease: (() => void) | null = null;
    try {
      for (;;) {
        const frame = await this.q.shift(signal);
        if (frame.kind === MessageKind.StreamEnd) {
          try {
            if ((frame.aux >>> 0) !== 0) {
              const err = this.codec.decode(frame.payload);
              throw toError(err);
            }
            return;
          } finally {
            frame.release();
            this.done = true;
          }
        }
        if (frame.kind !== MessageKind.StreamPush) {
          frame.release();
          continue;
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (currentRelease === release) currentRelease = null;
          frame.release();
          this.sendCredit();
        };
        currentRelease = release;
        yield { bytes: frame.payload, release };
      }
    } finally {
      if (currentRelease) currentRelease();
      if (signal) signal.removeEventListener("abort", abortListener);
    }
  }

  cancel() {
    if (this.done) return;
    this.done = true;
    for (const frame of this.q.drain()) frame.release();
    this.q.close(abortError());
    void this.router
      .send({
        kind: MessageKind.StreamCancel,
        id: 0,
        streamId: this.streamId,
        flags: 0,
        aux: 0,
        payload: new Uint8Array(0),
      })
      .catch(() => {
        return undefined;
      });
  }

  private sendCredit() {
    if (this.creditEach <= 0) return;
    if (this.done) return;
    void this.router
      .send({
        kind: MessageKind.StreamCredit,
        id: 0,
        streamId: this.streamId,
        flags: 0,
        aux: this.creditEach,
        payload: new Uint8Array(0),
      })
      .catch(() => {
        return undefined;
      });
  }
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? "" };
  }
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

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
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


