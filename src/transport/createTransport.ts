import type { ConnectOptions } from "../endpoint/connection.js";
import { HEADER_BYTES } from "../protocol/header.js";
import type { MessageKind } from "../protocol/kinds.js";
import { PostMessageTransport } from "./postMessage.js";
import { SabTransport, sabClientHandshake, sabServerHandshake } from "./sab.js";
import { isSabEligible } from "./sabEligibility.js";

export type TransportKind = "sab" | "postMessage";

export type OutgoingFrame = {
  kind: MessageKind;
  id: number;
  streamId: number;
  flags: number;
  aux: number;
  payload: Uint8Array;
};

export type IncomingFrame = {
  kind: MessageKind;
  id: number;
  streamId: number;
  flags: number;
  aux: number;
  payload: Uint8Array;
  release(): void;
};

export type Transport = {
  readonly kind: TransportKind;
  readonly payloadCapacity: number;
  send(frame: OutgoingFrame, opts?: { signal?: AbortSignal }): Promise<void>;
  sendTransfer?(frame: OutgoingFrame, buffer: ArrayBuffer, opts?: { signal?: AbortSignal }): Promise<void>;
  recv(opts?: { signal?: AbortSignal }): AsyncIterable<IncomingFrame>;
  close(): void;
  getStats(): {
    sentFrames: number;
    sentBytes: number;
    recvFrames: number;
    recvBytes: number;
    freeOutgoing: number;
  };
};

type PortLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
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

type TransportSelection =
  | { kind: "postMessage"; blockSize?: number; blockCount?: number }
  | { kind: "sab"; first: unknown };

type ListenerHandler = ((value: unknown) => void) & { __listener?: EventListener };

export async function createTransport(port: PortLike, _role: "client" | "server", opts: ConnectOptions): Promise<Transport> {
  const mode = opts.mode ?? "auto";
  const blockCount = normalizeBlockCount(opts.blockCount);
  const sabBlockSize = normalizeBlockSize(opts.blockSize, 64 * 1024);
  const postMessageBlockSize = normalizeBlockSize(opts.blockSize, 8 * 1024);

  if (_role === "client") {
    const wantSab = mode === "sab" || (mode === "auto" && isSabEligible());
    if (wantSab) {
      const setup = await sabClientHandshake(port, sabBlockSize, blockCount);
      return new SabTransport("client", setup);
    }
    port.postMessage({ t: "sikiopipe:transport", kind: "postMessage", blockSize: postMessageBlockSize, blockCount });
    return new PostMessageTransport(port, { blockSize: postMessageBlockSize, blockCount });
  }

  if (mode === "postMessage") {
    return new PostMessageTransport(port, { blockSize: postMessageBlockSize, blockCount });
  }

  if (mode === "sab") {
    if (!isSabEligible()) throw new Error("SAB transport not available");
    const setup = await sabServerHandshake(port);
    return new SabTransport("server", setup);
  }

  const selected = await waitForSelectedTransport(port);
  if (selected.kind === "sab") {
    if (!isSabEligible()) throw new Error("SAB transport not available");
    const setup = await sabServerHandshake(port, selected.first);
    return new SabTransport("server", setup);
  }
  const selectedBlockSize = normalizeBlockSize(selected.blockSize, postMessageBlockSize);
  const selectedBlockCount = normalizeBlockCount(selected.blockCount ?? blockCount);
  return new PostMessageTransport(port, { blockSize: selectedBlockSize, blockCount: selectedBlockCount });
}

function normalizeBlockSize(blockSize: number | undefined, fallback: number) {
  const v = blockSize ?? fallback;
  if (!Number.isInteger(v) || v <= HEADER_BYTES) throw new RangeError("Invalid blockSize");
  if (v % 4 !== 0) throw new RangeError("blockSize must be a multiple of 4");
  return v;
}

function normalizeBlockCount(blockCount: number | undefined) {
  const v = blockCount ?? 64;
  if (!Number.isInteger(v) || v <= 0) throw new RangeError("Invalid blockCount");
  if ((v & (v - 1)) !== 0) throw new RangeError("blockCount must be a power of two");
  return v;
}

async function waitForSelectedTransport(port: PortLike): Promise<TransportSelection> {
  return await new Promise((resolve) => {
    const handler: ListenerHandler = (evOrValue) => {
      const data = isMessageEvent(evOrValue) ? evOrValue.data : evOrValue;
      if (!isRecord(data)) return;
      if (data.t === "sikiopipe:sabSetup") {
        removeListener(port, handler);
        resolve({ kind: "sab", first: data });
        return;
      }
      if (data.t === "sikiopipe:transport" && data.kind === "postMessage") {
        removeListener(port, handler);
        const blockSize = readNumber(data.blockSize);
        const blockCount = readNumber(data.blockCount);
        const selection: { kind: "postMessage"; blockSize?: number; blockCount?: number } = { kind: "postMessage" };
        if (blockSize !== undefined) selection.blockSize = blockSize;
        if (blockCount !== undefined) selection.blockCount = blockCount;
        resolve(selection);
      }
    };
    addListener(port, handler);
  });
}

function addListener(port: PortLike, handler: ListenerHandler) {
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = (ev) => {
      handler(ev as MessageEvent<unknown>);
    };
    handler.__listener = listener;
    port.addEventListener("message", listener);
    return;
  }
  port.on?.("message", handler);
}

function removeListener(port: PortLike, handler: ListenerHandler) {
  if (typeof port.removeEventListener === "function") {
    const listener = handler.__listener;
    if (listener) port.removeEventListener("message", listener);
    return;
  }
  port.off?.("message", handler);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageEvent(value: unknown): value is MessageEvent<unknown> {
  return isRecord(value) && "data" in value;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


