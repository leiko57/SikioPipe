import type { ConnectOptions } from "../endpoint/connection.js";
import type { MessageKind } from "../protocol/kinds.js";
import { HEADER_BYTES } from "../protocol/header.js";
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

export async function createTransport(port: unknown, _role: "client" | "server", opts: ConnectOptions): Promise<Transport> {
  const mode = opts.mode ?? "auto";
  const blockSize = normalizeBlockSize(opts.blockSize);
  const blockCount = normalizeBlockCount(opts.blockCount);

  if (_role === "client") {
    const wantSab = mode === "sab" || (mode === "auto" && isSabEligible());
    if (wantSab) {
      const setup = await sabClientHandshake(port as any, blockSize, blockCount);
      return new SabTransport("client", setup);
    }
    (port as any).postMessage?.({ t: "sikiopipe:transport", kind: "postMessage", blockSize, blockCount });
    return new PostMessageTransport(port as any, { blockSize, blockCount });
  }

  if (mode === "postMessage") {
    return new PostMessageTransport(port as any, { blockSize, blockCount });
  }

  if (mode === "sab") {
    if (!isSabEligible()) throw new Error("SAB transport not available");
    const setup = await sabServerHandshake(port as any);
    return new SabTransport("server", setup);
  }

  const selected = await waitForSelectedTransport(port as any);
  if (selected.kind === "sab") {
    if (!isSabEligible()) throw new Error("SAB transport not available");
    const setup = await sabServerHandshake(port as any, selected.first);
    return new SabTransport("server", setup);
  }
  const selectedBlockSize = normalizeBlockSize(selected.blockSize ?? blockSize);
  const selectedBlockCount = normalizeBlockCount(selected.blockCount ?? blockCount);
  return new PostMessageTransport(port as any, { blockSize: selectedBlockSize, blockCount: selectedBlockCount });
}

function normalizeBlockSize(blockSize: number | undefined) {
  const v = blockSize ?? 64 * 1024;
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

async function waitForSelectedTransport(
  port: any,
): Promise<{ kind: "postMessage"; blockSize?: number; blockCount?: number } | { kind: "sab"; first: any }> {
  return await new Promise((resolve) => {
    const handler = (evOrValue: unknown) => {
      const data = typeof evOrValue === "object" && evOrValue !== null && "data" in (evOrValue as any) ? (evOrValue as any).data : evOrValue;
      if (typeof data !== "object" || data === null) return;
      if ((data as any).t === "sikiopipe:sabSetup") {
        removeListener(port, handler);
        resolve({ kind: "sab", first: data });
        return;
      }
      if ((data as any).t === "sikiopipe:transport" && (data as any).kind === "postMessage") {
        removeListener(port, handler);
        resolve({
          kind: "postMessage",
          blockSize: (data as any).blockSize,
          blockCount: (data as any).blockCount,
        });
      }
    };
    addListener(port, handler);
  });
}

function addListener(port: any, handler: (value: unknown) => void) {
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = (ev) => handler(ev as MessageEvent);
    (handler as any).__listener = listener;
    port.addEventListener("message", listener);
    return;
  }
  port.on?.("message", handler);
}

function removeListener(port: any, handler: (value: unknown) => void) {
  if (typeof port.removeEventListener === "function") {
    const listener = (handler as any).__listener;
    if (listener) port.removeEventListener("message", listener);
    return;
  }
  port.off?.("message", handler);
}


