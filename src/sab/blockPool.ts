import { type FrameHeaderOut, HEADER_BYTES, readHeader, writeHeader } from "../protocol/header.js";
import type { OutgoingFrame } from "../transport/createTransport.js";

export class SabBlockPool {
  readonly blockSize: number;
  readonly blockCount: number;
  readonly payloadCapacity: number;

  private readonly u8: Uint8Array;
  private readonly u32: Uint32Array;
  private readonly blockWordStride: number;

  constructor(sab: SharedArrayBuffer, blockSize: number, blockCount: number) {
    if (blockSize % 4 !== 0) throw new RangeError("blockSize must be a multiple of 4");
    if (sab.byteLength < blockSize * blockCount) throw new RangeError("Invalid block pool");
    this.blockSize = blockSize;
    this.blockCount = blockCount;
    this.payloadCapacity = blockSize - HEADER_BYTES;
    this.u8 = new Uint8Array(sab);
    this.u32 = new Uint32Array(sab);
    this.blockWordStride = blockSize >>> 2;
  }

  write(blockIndex: number, frame: OutgoingFrame) {
    const idx = blockIndex >>> 0;
    if (idx >= this.blockCount) throw new RangeError("Invalid blockIndex");
    if (frame.payload.byteLength > this.payloadCapacity) throw new RangeError("Frame too large");
    const blockByteOffset = idx * this.blockSize;
    const headerWordOffset = idx * this.blockWordStride;

    writeHeader(this.u32, headerWordOffset, {
      kind: frame.kind,
      id: frame.id,
      streamId: frame.streamId,
      flags: frame.flags,
      payloadLength: frame.payload.byteLength,
      aux: frame.aux,
    });

    const payloadByteOffset = blockByteOffset + HEADER_BYTES;
    this.u8.set(frame.payload, payloadByteOffset);
  }

  read(blockIndex: number, out: FrameHeaderOut): Uint8Array {
    const idx = blockIndex >>> 0;
    if (idx >= this.blockCount) throw new RangeError("Invalid blockIndex");
    const blockByteOffset = idx * this.blockSize;
    const headerWordOffset = idx * this.blockWordStride;
    readHeader(this.u32, headerWordOffset, out);
    const payloadLen = out.payloadLength;
    if (payloadLen > this.payloadCapacity) throw new RangeError("Invalid payloadLength");
    return this.u8.subarray(blockByteOffset + HEADER_BYTES, blockByteOffset + HEADER_BYTES + payloadLen);
  }
}


