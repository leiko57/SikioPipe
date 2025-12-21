import { AsyncQueue } from "../internal/asyncQueue.js";
import { abortPromise, abortError, throwIfAborted } from "../internal/abort.js";
import { MessageKind } from "../protocol/kinds.js";
import type { FrameRouter } from "../endpoint/router.js";
import type { Codec } from "./codec.js";
import type { IncomingFrame } from "../transport/createTransport.js";

export const STREAM_REF_KEY = "__sikiopipe_stream__" as const;

export type StreamRef = {
  [STREAM_REF_KEY]: number;
};

export function makeStreamRef(id: number): StreamRef {
  return { [STREAM_REF_KEY]: id >>> 0 };
}

export function isStreamRef(value: unknown): value is StreamRef {
  return typeof value === "object" && value !== null && STREAM_REF_KEY in (value as any) && Number.isInteger((value as any)[STREAM_REF_KEY]);
}

export class StreamSender {
  readonly streamId: number;
  private readonly router: FrameRouter;
  private readonly codec: Codec;
  private credits = 0;
  private readonly creditSignal = new AsyncQueue<void>();
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
    this.creditSignal.push(undefined);
  }

  cancelFromRemote() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.creditSignal.close(new Error("Cancelled"));
  }

  async start(source: AsyncIterable<Uint8Array>, opts?: { signal?: AbortSignal }) {
    const it = source[Symbol.asyncIterator]();
    let ended = false;
    try {
      while (!this.cancelled) {
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
    } catch (e) {
      if (!this.cancelled) {
        const payload = this.codec.encode(serializeError(e));
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
        } catch {
          return;
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
      await this.creditSignal.shift(signal);
    }
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
        .catch(() => undefined);
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
    const abortListener = () => this.cancel();
    if (signal) signal.addEventListener("abort", abortListener, { once: true });
    try {
      while (true) {
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
        if (this.creditEach > 0) {
          void this.router
            .send({
            kind: MessageKind.StreamCredit,
            id: 0,
            streamId: this.streamId,
            flags: 0,
            aux: this.creditEach,
            payload: new Uint8Array(0),
          })
            .catch(() => undefined);
        }
        yield out;
      }
    } finally {
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
      .catch(() => undefined);
  }
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? "" };
  }
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


