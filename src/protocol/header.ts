import type { MessageKind } from "./kinds.js";

export const HEADER_WORDS = 6;
export const HEADER_BYTES = HEADER_WORDS * 4;

export const FrameFlags = {
  None: 0,
  Chunked: 1,
} as const;

export type FrameHeader = {
  kind: MessageKind;
  id: number;
  streamId: number;
  flags: number;
  payloadLength: number;
  aux: number;
};

export type FrameHeaderOut = {
  kind: MessageKind;
  id: number;
  streamId: number;
  flags: number;
  payloadLength: number;
  aux: number;
};

export function writeHeader(view: Uint32Array, wordOffset: number, h: FrameHeader) {
  view[wordOffset + 0] = h.kind;
  view[wordOffset + 1] = h.id >>> 0;
  view[wordOffset + 2] = h.streamId >>> 0;
  view[wordOffset + 3] = h.flags >>> 0;
  view[wordOffset + 4] = h.payloadLength >>> 0;
  view[wordOffset + 5] = h.aux >>> 0;
}

export function readHeader(view: Uint32Array, wordOffset: number, out: FrameHeaderOut): FrameHeaderOut {
  out.kind = view[wordOffset + 0]! as MessageKind;
  out.id = view[wordOffset + 1]! >>> 0;
  out.streamId = view[wordOffset + 2]! >>> 0;
  out.flags = view[wordOffset + 3]! >>> 0;
  out.payloadLength = view[wordOffset + 4]! >>> 0;
  out.aux = view[wordOffset + 5]! >>> 0;
  return out;
}

export function getBlockStride(blockSize: number) {
  if (!Number.isInteger(blockSize) || blockSize <= HEADER_BYTES) {
    throw new RangeError("Invalid blockSize");
  }
  return blockSize;
}

export function getPayloadCapacity(blockSize: number) {
  return getBlockStride(blockSize) - HEADER_BYTES;
}

export function getPayloadByteOffsetInBlock() {
  return HEADER_BYTES;
}


