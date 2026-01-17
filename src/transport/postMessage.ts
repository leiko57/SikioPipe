import { AsyncQueue } from "../internal/asyncQueue.js";
import { type FrameHeaderOut, getPayloadCapacity, HEADER_BYTES, HEADER_WORDS, readHeader, writeHeader } from "../protocol/header.js";
import { MessageKind } from "../protocol/kinds.js";
import type { IncomingFrame, OutgoingFrame, Transport } from "./createTransport.js";

type PortLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  start?: () => void;
  close?: () => void;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => void;
  on?: (event: "message", listener: (value: unknown) => void) => void;
  off?: (event: "message", listener: (value: unknown) => void) => void;
};

export type PostMessageTransportOptions = {
  blockSize: number;
  blockCount: number;
};

export class PostMessageTransport implements Transport {
  readonly kind = "postMessage" as const;

  private readonly port: PortLike;
  private readonly blockSize: number;
  readonly payloadCapacity: number;
  private readonly freeOutgoing = new AsyncQueue<ArrayBuffer>();
  private readonly inbound = new AsyncQueue<IncomingFrame>();
  private readonly headerOut: FrameHeaderOut = {
    kind: MessageKind.Data,
    id: 0,
    streamId: 0,
    flags: 0,
    payloadLength: 0,
    aux: 0,
  };
  private closed = false;

  private sentFrames = 0;
  private sentBytes = 0;
  private recvFrames = 0;
  private recvBytes = 0;

  private readonly onMessage = (evOrValue: unknown) => {
    const data = isMessageEvent(evOrValue) ? evOrValue.data : evOrValue;
    if (!(data instanceof ArrayBuffer)) return;
    if (data.byteLength < HEADER_BYTES) return;
    const u32 = new Uint32Array(data, 0, HEADER_WORDS);
    readHeader(u32, 0, this.headerOut);

    if (this.headerOut.kind === MessageKind.TransportReturnBuffer) {
      if (data.byteLength === this.blockSize) this.freeOutgoing.push(data);
      return;
    }

    const payloadLength = this.headerOut.payloadLength;
    const maxPayload = data.byteLength - HEADER_BYTES;
    if (payloadLength > maxPayload) {
      this.returnBuffer(data);
      return;
    }

    const payload = new Uint8Array(data, HEADER_BYTES, payloadLength);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.returnBuffer(data);
    };

    const frame: IncomingFrame = {
      kind: this.headerOut.kind,
      id: this.headerOut.id,
      streamId: this.headerOut.streamId,
      flags: this.headerOut.flags,
      aux: this.headerOut.aux,
      payload,
      release,
    };

    this.recvFrames += 1;
    this.recvBytes += payloadLength;
    this.inbound.push(frame);
  };

  private readonly onMessageListener: EventListener = (ev) => {
    this.onMessage(ev as MessageEvent<unknown>);
  };
  private readonly useEventTarget: boolean;

  constructor(port: PortLike, opts: PostMessageTransportOptions) {
    this.port = port;
    this.blockSize = opts.blockSize;
    this.payloadCapacity = getPayloadCapacity(opts.blockSize);

    for (let i = 0; i < opts.blockCount; i++) {
      this.freeOutgoing.push(new ArrayBuffer(this.blockSize));
    }

    this.useEventTarget = typeof this.port.addEventListener === "function" && typeof this.port.on !== "function";
    if (this.useEventTarget) {
      this.port.addEventListener?.("message", this.onMessageListener);
      this.port.start?.();
    } else {
      this.port.on?.("message", this.onMessage);
    }
  }

  async send(frame: OutgoingFrame, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.closed) throw new Error("Closed");
    const payloadLength = frame.payload.byteLength;
    if (payloadLength <= this.payloadCapacity) {
      const buffer = await this.freeOutgoing.shift(opts?.signal);
      const u32 = new Uint32Array(buffer, 0, HEADER_WORDS);
      writeHeader(u32, 0, {
        kind: frame.kind,
        id: frame.id,
        streamId: frame.streamId,
        flags: frame.flags,
        payloadLength,
        aux: frame.aux,
      });
      new Uint8Array(buffer, HEADER_BYTES, payloadLength).set(frame.payload);
      this.port.postMessage(buffer, [buffer]);
    } else {
      if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const buffer = new ArrayBuffer(HEADER_BYTES + payloadLength);
      const u32 = new Uint32Array(buffer, 0, HEADER_WORDS);
      writeHeader(u32, 0, {
        kind: frame.kind,
        id: frame.id,
        streamId: frame.streamId,
        flags: frame.flags,
        payloadLength,
        aux: frame.aux,
      });
      new Uint8Array(buffer, HEADER_BYTES, payloadLength).set(frame.payload);
      this.port.postMessage(buffer, [buffer]);
    }
    this.sentFrames += 1;
    this.sentBytes += payloadLength;
  }

  sendTransfer(frame: OutgoingFrame, buffer: ArrayBuffer, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.closed) throw new Error("Closed");
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (frame.payload.buffer !== buffer) throw new RangeError("Transfer buffer mismatch");
    if (frame.payload.byteOffset !== HEADER_BYTES) throw new RangeError("Invalid transfer payload offset");
    if (buffer.byteLength < HEADER_BYTES + frame.payload.byteLength) throw new RangeError("Invalid transfer buffer");

    const u32 = new Uint32Array(buffer, 0, HEADER_WORDS);
    writeHeader(u32, 0, {
      kind: frame.kind,
      id: frame.id,
      streamId: frame.streamId,
      flags: frame.flags,
      payloadLength: frame.payload.byteLength,
      aux: frame.aux,
    });
    this.port.postMessage(buffer, [buffer]);
    this.sentFrames += 1;
    this.sentBytes += frame.payload.byteLength;
    return Promise.resolve();
  }

  async *recv(opts?: { signal?: AbortSignal }): AsyncIterable<IncomingFrame> {
    for (;;) {
      const frame = await this.inbound.shift(opts?.signal);
      yield frame;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.useEventTarget) {
      this.port.removeEventListener?.("message", this.onMessageListener);
    } else {
      this.port.off?.("message", this.onMessage);
    }
    this.inbound.close();
    this.freeOutgoing.close();
    this.port.close?.();
  }

  getStats() {
    return {
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      recvFrames: this.recvFrames,
      recvBytes: this.recvBytes,
      freeOutgoing: this.freeOutgoing.size(),
    };
  }

  private returnBuffer(buffer: ArrayBuffer) {
    if (this.closed) return;
    if (buffer.byteLength !== this.blockSize) return;
    const u32 = new Uint32Array(buffer, 0, HEADER_WORDS);
    writeHeader(u32, 0, {
      kind: MessageKind.TransportReturnBuffer,
      id: 0,
      streamId: 0,
      flags: 0,
      payloadLength: 0,
      aux: 0,
    });
    this.port.postMessage(buffer, [buffer]);
  }
}

function isMessageEvent(value: unknown): value is MessageEvent<unknown> {
  return typeof value === "object" && value !== null && "data" in value;
}


