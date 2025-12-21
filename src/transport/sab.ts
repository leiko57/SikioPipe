import { MessageKind } from "../protocol/kinds.js";
import { getPayloadCapacity } from "../protocol/header.js";
import { SabBlockPool } from "../sab/blockPool.js";
import { SpscRing } from "../sab/spscRing.js";
import type { IncomingFrame, OutgoingFrame, Transport } from "./createTransport.js";

type PortLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  start?: () => void;
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

const SAB_SETUP = "sikiopipe:sabSetup";
const SAB_ACK = "sikiopipe:sabAck";

export type SabSetup = {
  blockSize: number;
  blockCount: number;
  blocksM2W: SharedArrayBuffer;
  blocksW2M: SharedArrayBuffer;
  dataRingM2W: SharedArrayBuffer;
  freeRingM2W: SharedArrayBuffer;
  dataRingW2M: SharedArrayBuffer;
  freeRingW2M: SharedArrayBuffer;
};

export async function sabClientHandshake(port: PortLike, blockSize: number, blockCount: number): Promise<SabSetup> {
  const setup = allocateSabSetup(blockSize, blockCount);
  port.postMessage({ t: SAB_SETUP, setup });
  await waitFor(port, (msg) => isObj(msg) && msg.t === SAB_ACK);
  return setup;
}

export async function sabServerHandshake(port: PortLike, first?: any): Promise<SabSetup> {
  const msg = first && isObj(first) && first.t === SAB_SETUP ? first : await waitFor(port, (m) => isObj(m) && m.t === SAB_SETUP);
  const setup = (msg as { setup: SabSetup }).setup;
  port.postMessage({ t: SAB_ACK });
  return setup;
}

export class SabTransport implements Transport {
  readonly kind = "sab" as const;
  readonly payloadCapacity: number;

  private readonly sendFree: SpscRing;
  private readonly sendData: SpscRing;
  private readonly sendPool: SabBlockPool;

  private readonly recvData: SpscRing;
  private readonly recvFree: SpscRing;
  private readonly recvPool: SabBlockPool;

  private readonly headerOut = {
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

  constructor(role: "client" | "server", setup: SabSetup) {
    const blockSize = setup.blockSize;
    const blockCount = setup.blockCount;
    const poolM2W = new SabBlockPool(setup.blocksM2W, blockSize, blockCount);
    const poolW2M = new SabBlockPool(setup.blocksW2M, blockSize, blockCount);
    const dataM2W = new SpscRing(setup.dataRingM2W, blockCount);
    const freeM2W = new SpscRing(setup.freeRingM2W, blockCount);
    const dataW2M = new SpscRing(setup.dataRingW2M, blockCount);
    const freeW2M = new SpscRing(setup.freeRingW2M, blockCount);

    if (role === "client") {
      this.sendPool = poolM2W;
      this.sendData = dataM2W;
      this.sendFree = freeM2W;

      this.recvPool = poolW2M;
      this.recvData = dataW2M;
      this.recvFree = freeW2M;
    } else {
      this.sendPool = poolW2M;
      this.sendData = dataW2M;
      this.sendFree = freeW2M;

      this.recvPool = poolM2W;
      this.recvData = dataM2W;
      this.recvFree = freeM2W;
    }
    this.payloadCapacity = this.sendPool.payloadCapacity;
  }

  async send(frame: OutgoingFrame, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.closed) throw new Error("Closed");
    if (frame.payload.byteLength > this.sendPool.payloadCapacity) throw new RangeError("Frame too large");
    const blockIndex = await this.sendFree.pop(opts?.signal);
    this.sendPool.write(blockIndex, frame);
    await this.sendData.push(blockIndex, opts?.signal);
    this.sentFrames += 1;
    this.sentBytes += frame.payload.byteLength;
  }

  async *recv(opts?: { signal?: AbortSignal }): AsyncIterable<IncomingFrame> {
    while (true) {
      if (this.closed) throw new Error("Closed");
      const blockIndex = await this.recvData.pop(opts?.signal);
      const payload = this.recvPool.read(blockIndex, this.headerOut);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.recvFree.pushSync(blockIndex);
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
      this.recvBytes += payload.byteLength;
      yield frame;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendFree.close();
    this.sendData.close();
    this.recvData.close();
    this.recvFree.close();
  }

  getStats() {
    return {
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      recvFrames: this.recvFrames,
      recvBytes: this.recvBytes,
      freeOutgoing: this.sendFree.count(),
    };
  }
}

function allocateSabSetup(blockSize: number, blockCount: number): SabSetup {
  const payloadCapacity = getPayloadCapacity(blockSize);
  if (payloadCapacity <= 0) throw new RangeError("Invalid blockSize");
  if (blockSize % 4 !== 0) throw new RangeError("blockSize must be a multiple of 4");
  if ((blockCount & (blockCount - 1)) !== 0) throw new RangeError("blockCount must be a power of two");

  const blocksM2W = new SharedArrayBuffer(blockSize * blockCount);
  const blocksW2M = new SharedArrayBuffer(blockSize * blockCount);
  const dataRingM2W = SpscRing.allocate(blockCount);
  const freeRingM2W = SpscRing.allocate(blockCount);
  const dataRingW2M = SpscRing.allocate(blockCount);
  const freeRingW2M = SpscRing.allocate(blockCount);

  new SpscRing(dataRingM2W, blockCount).initFilled(0, () => 0);
  new SpscRing(dataRingW2M, blockCount).initFilled(0, () => 0);
  new SpscRing(freeRingM2W, blockCount).initFilled(blockCount, (i) => i);
  new SpscRing(freeRingW2M, blockCount).initFilled(blockCount, (i) => i);

  return {
    blockSize,
    blockCount,
    blocksM2W,
    blocksW2M,
    dataRingM2W,
    freeRingM2W,
    dataRingW2M,
    freeRingW2M,
  };
}

async function waitFor(port: PortLike, predicate: (data: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const handler = (evOrValue: unknown) => {
      const data = isMessageEvent(evOrValue) ? (evOrValue as MessageEvent).data : evOrValue;
      if (!predicate(data)) return;
      removeListener(port, handler);
      resolve(data);
    };
    addListener(port, handler);
  });
}

function addListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = (ev) => handler(ev as MessageEvent);
    (handler as unknown as { __listener?: EventListener }).__listener = listener;
    port.addEventListener("message", listener);
    return;
  }
  port.on?.("message", handler);
}

function removeListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.removeEventListener === "function") {
    const listener = (handler as unknown as { __listener?: EventListener }).__listener;
    if (listener) port.removeEventListener("message", listener);
    return;
  }
  port.off?.("message", handler);
}

function isObj(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isMessageEvent(value: unknown): value is MessageEvent {
  return isObj(value) && "data" in value;
}


