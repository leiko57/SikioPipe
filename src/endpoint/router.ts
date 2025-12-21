import { AsyncQueue } from "../internal/asyncQueue.js";
import { FrameFlags } from "../protocol/header.js";
import { MessageKind } from "../protocol/kinds.js";
import type { IncomingFrame, OutgoingFrame, Transport } from "../transport/createTransport.js";

const CHUNK_HEADER_WORDS = 6;
const CHUNK_HEADER_BYTES = CHUNK_HEADER_WORDS * 4;
const CHUNK_STREAM_BIT = 0x80000000;
const EMPTY_PAYLOAD = new Uint8Array(0);

type ChunkState = {
  kind: MessageKind;
  id: number;
  streamId: number;
  flags: number;
  aux: number;
  total: number;
  received: number;
  buffer: Uint8Array;
};

export class FrameRouter {
  private readonly transport: Transport;
  private readonly queues = new Map<MessageKind, AsyncQueue<IncomingFrame>>();
  private readonly chunkStreams = new Map<number, ChunkState>();
  private chunkSeq = 1;
  private latencyLast = 0;
  private latencyMin = 0;
  private latencyMax = 0;
  private latencySum = 0;
  private latencySamples = 0;
  private closed = false;

  constructor(transport: Transport) {
    this.transport = transport;
    void this.pump();
  }

  async send(frame: OutgoingFrame, opts?: { signal?: AbortSignal }) {
    if (this.closed) throw new Error("Closed");
    const capacity = this.transport.payloadCapacity;
    if (capacity > 0 && frame.payload.byteLength > capacity && (frame.flags & FrameFlags.Chunked) === 0) {
      await this.sendChunked(frame, capacity, opts);
      return;
    }
    await this.transport.send(frame, opts);
  }

  async *recv(kind: MessageKind, opts?: { signal?: AbortSignal }): AsyncIterable<IncomingFrame> {
    const q = this.getQueue(kind);
    while (true) {
      const frame = await q.shift(opts?.signal);
      yield frame;
    }
  }

  getStats() {
    const transportStats = this.transport.getStats();
    const queues: Record<number, { size: number; waiters: number }> = {};
    for (const [kind, q] of this.queues) {
      queues[kind] = q.stats();
    }
    const latencyMs =
      this.latencySamples > 0
        ? {
            last: this.latencyLast,
            avg: this.latencySum / this.latencySamples,
            min: this.latencyMin,
            max: this.latencyMax,
            samples: this.latencySamples,
          }
        : undefined;
    return {
      ...transportStats,
      queues,
      chunked: { active: this.chunkStreams.size },
      ...(latencyMs ? { latencyMs } : {}),
    };
  }

  close(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    const e = err ?? new Error("Closed");
    this.chunkStreams.clear();
    for (const q of this.queues.values()) {
      for (const frame of q.drain()) frame.release();
      q.close(e);
    }
    this.transport.close();
  }

  private getQueue(kind: MessageKind) {
    const existing = this.queues.get(kind);
    if (existing) return existing;
    const q = new AsyncQueue<IncomingFrame>();
    this.queues.set(kind, q);
    return q;
  }

  private async pump() {
    try {
      for await (const frame of this.transport.recv()) {
        if (this.closed) {
          frame.release();
          continue;
        }
        if (this.handleChunkFrame(frame)) continue;
        this.getQueue(frame.kind).push(frame);
      }
      this.close();
    } catch (e) {
      this.close(e instanceof Error ? e : new Error(String(e)));
    }
  }

  recordLatency(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencyLast = ms;
    if (this.latencySamples === 0 || ms < this.latencyMin) this.latencyMin = ms;
    if (this.latencySamples === 0 || ms > this.latencyMax) this.latencyMax = ms;
    this.latencySum += ms;
    this.latencySamples += 1;
  }

  private nextChunkStreamId() {
    const id = (this.chunkSeq++ & 0x7fffffff) | CHUNK_STREAM_BIT;
    return id >>> 0;
  }

  private async sendChunked(frame: OutgoingFrame, capacity: number, opts?: { signal?: AbortSignal }) {
    if (capacity <= CHUNK_HEADER_BYTES) throw new RangeError("Chunk header exceeds payload capacity");
    const total = frame.payload.byteLength >>> 0;
    const streamId = this.nextChunkStreamId();
    const firstData = Math.min(total, capacity - CHUNK_HEADER_BYTES);
    const firstPayload = new Uint8Array(CHUNK_HEADER_BYTES + firstData);
    const headerView = new Uint32Array(firstPayload.buffer, firstPayload.byteOffset, CHUNK_HEADER_WORDS);
    headerView[0] = frame.kind;
    headerView[1] = frame.id >>> 0;
    headerView[2] = frame.streamId >>> 0;
    headerView[3] = frame.flags >>> 0;
    headerView[4] = frame.aux >>> 0;
    headerView[5] = total;
    firstPayload.set(frame.payload.subarray(0, firstData), CHUNK_HEADER_BYTES);
    await this.transport.send(
      {
        kind: MessageKind.StreamPush,
        id: 0,
        streamId,
        flags: FrameFlags.Chunked,
        aux: 0,
        payload: firstPayload,
      },
      opts,
    );
    let offset = firstData;
    while (offset < total) {
      const len = Math.min(capacity, total - offset);
      const payload = frame.payload.subarray(offset, offset + len);
      await this.transport.send(
        {
          kind: MessageKind.StreamPush,
          id: 0,
          streamId,
          flags: FrameFlags.Chunked,
          aux: 0,
          payload,
        },
        opts,
      );
      offset += len;
    }
    await this.transport.send(
      {
        kind: MessageKind.StreamEnd,
        id: 0,
        streamId,
        flags: FrameFlags.Chunked,
        aux: 0,
        payload: EMPTY_PAYLOAD,
      },
      opts,
    );
  }

  private handleChunkFrame(frame: IncomingFrame) {
    if ((frame.flags & FrameFlags.Chunked) === 0) return false;
    if (frame.kind === MessageKind.StreamPush) {
      this.handleChunkPush(frame);
      return true;
    }
    if (frame.kind === MessageKind.StreamEnd) {
      this.handleChunkEnd(frame);
      return true;
    }
    return false;
  }

  private handleChunkPush(frame: IncomingFrame) {
    const streamId = frame.streamId >>> 0;
    const payload = frame.payload;
    const existing = this.chunkStreams.get(streamId);
    if (!existing) {
      if (payload.byteLength < CHUNK_HEADER_BYTES) {
        frame.release();
        return;
      }
      const headerView = new Uint32Array(payload.buffer, payload.byteOffset, CHUNK_HEADER_WORDS);
      const kind = headerView[0] ?? 0;
      const id = headerView[1] ?? 0;
      const originalStreamId = headerView[2] ?? 0;
      const flags = headerView[3] ?? 0;
      const aux = headerView[4] ?? 0;
      const total = (headerView[5] ?? 0) >>> 0;
      const buffer = new Uint8Array(total);
      const available = payload.byteLength - CHUNK_HEADER_BYTES;
      let received = 0;
      if (available > 0) {
        const toCopy = Math.min(available, total);
        buffer.set(payload.subarray(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + toCopy), 0);
        received = toCopy;
      }
      this.chunkStreams.set(streamId, {
        kind: kind as MessageKind,
        id: id >>> 0,
        streamId: originalStreamId >>> 0,
        flags: flags >>> 0,
        aux: aux >>> 0,
        total,
        received,
        buffer,
      });
      frame.release();
      return;
    }
    const remaining = existing.total - existing.received;
    if (remaining <= 0) {
      frame.release();
      return;
    }
    const toCopy = Math.min(payload.byteLength, remaining);
    existing.buffer.set(payload.subarray(0, toCopy), existing.received);
    existing.received += toCopy;
    frame.release();
  }

  private handleChunkEnd(frame: IncomingFrame) {
    const streamId = frame.streamId >>> 0;
    const state = this.chunkStreams.get(streamId);
    if (!state) {
      frame.release();
      return;
    }
    this.chunkStreams.delete(streamId);
    frame.release();
    if (state.received < state.total) return;
    const outFrame: IncomingFrame = {
      kind: state.kind,
      id: state.id,
      streamId: state.streamId,
      flags: state.flags,
      aux: state.aux,
      payload: state.buffer,
      release: () => {},
    };
    this.getQueue(outFrame.kind).push(outFrame);
  }
}


