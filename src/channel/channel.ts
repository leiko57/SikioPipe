import type { Connection } from "../endpoint/connection.js";
import { HEADER_BYTES } from "../protocol/header.js";
import { MessageKind } from "../protocol/kinds.js";

export type BorrowedChunk = {
  readonly bytes: Uint8Array;
  release(): void;
};

export type TransferPayload = {
  readonly buffer: ArrayBuffer;
  readonly payload: Uint8Array;
};

export type ChannelOptions = {};

export type Channel = {
  send(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  sendTransfer(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  recv(opts?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  recvBorrowed(opts?: { signal?: AbortSignal }): AsyncIterable<BorrowedChunk>;
};

export function createTransferPayload(byteLength: number): TransferPayload {
  if (!Number.isInteger(byteLength) || byteLength < 0) throw new RangeError("Invalid byteLength");
  const buffer = new ArrayBuffer(HEADER_BYTES + byteLength);
  const payload = new Uint8Array(buffer, HEADER_BYTES, byteLength);
  return { buffer, payload };
}

export function channel(_conn: Connection, _opts: ChannelOptions = {}): Channel {
  return {
    async send(bytes, opts) {
      await _conn.router.send(
        {
          kind: MessageKind.Data,
          id: 0,
          streamId: 0,
          flags: 0,
          aux: 0,
          payload: bytes,
        },
        opts,
      );
    },
    async sendTransfer(bytes, opts) {
      const transport = _conn.transport;
      if (typeof transport.sendTransfer !== "function") throw new Error("sendTransfer is not supported");
      if (!(bytes.buffer instanceof ArrayBuffer)) throw new RangeError("Transfer payload must use ArrayBuffer");
      if (bytes.byteOffset !== HEADER_BYTES) throw new RangeError("Invalid transfer payload offset");
      if (bytes.byteLength > transport.payloadCapacity) throw new RangeError("Frame too large");
      if (bytes.buffer.byteLength < HEADER_BYTES + bytes.byteLength) throw new RangeError("Invalid transfer buffer");
      await transport.sendTransfer(
        {
          kind: MessageKind.Data,
          id: 0,
          streamId: 0,
          flags: 0,
          aux: 0,
          payload: bytes,
        },
        bytes.buffer,
        opts,
      );
    },
    async *recv(opts) {
      for await (const frame of _conn.router.recv(MessageKind.Data, opts)) {
        try {
          yield frame.payload.slice();
        } finally {
          frame.release();
        }
      }
    },
    async *recvBorrowed(opts) {
      for await (const frame of _conn.router.recv(MessageKind.Data, opts)) {
        yield {
          bytes: frame.payload,
          release: frame.release,
        };
      }
    },
  };
}


