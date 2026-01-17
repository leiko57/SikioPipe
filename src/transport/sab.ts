import { getPayloadCapacity } from "../protocol/header.js";
import { MessageKind } from "../protocol/kinds.js";
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
const debugSab =
  typeof process !== "undefined" &&
  (process.env.BENCH_DEBUG_SAB === "1" || process.env.SIKIOPIPE_DEBUG_SAB === "1");

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
  await waitFor(port, isSabAckMessage);
  return setup;
}

export async function sabServerHandshake(port: PortLike, first?: unknown): Promise<SabSetup> {
  const msg = first && isSabSetupMessage(first) ? first : await waitFor(port, isSabSetupMessage);
  const setup = msg.setup;
  port.postMessage({ t: SAB_ACK });
  return setup;
}

export class SabTransport implements Transport {
  readonly kind = "sab" as const;
  readonly payloadCapacity: number;
  private readonly role: "client" | "server";
  private readonly debug: boolean;
  private debugFrames = 0;

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
    this.role = role;
    this.debug = debugSab;
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
    this.logDebug("send", blockIndex);
  }

  async *recv(opts?: { signal?: AbortSignal }): AsyncIterable<IncomingFrame> {
    for (;;) {
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
      this.logDebug("recv", blockIndex);
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

  debugState() {
    return {
      role: this.role,
      sendFree: this.sendFree.state(),
      sendData: this.sendData.state(),
      recvData: this.recvData.state(),
      recvFree: this.recvFree.state(),
    };
  }

  private logDebug(label: string, blockIndex: number) {
    if (!this.debug) return;
    if (this.debugFrames >= 20) return;
    this.debugFrames += 1;
    const state = {
      role: this.role,
      label,
      blockIndex,
      sendFree: this.sendFree.state(),
      sendData: this.sendData.state(),
      recvData: this.recvData.state(),
      recvFree: this.recvFree.state(),
    };
    console.log(`sab: ${JSON.stringify(state)}`);
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

type SabSetupMessage = {
  t: typeof SAB_SETUP;
  setup: SabSetup;
};

type SabAckMessage = {
  t: typeof SAB_ACK;
};

async function waitFor<T>(port: PortLike, predicate: (data: unknown) => data is T): Promise<T> {
  return new Promise((resolve) => {
    const handler = (evOrValue: unknown) => {
      const data = isMessageEvent(evOrValue) ? evOrValue.data : evOrValue;
      if (!predicate(data)) return;
      removeListener(port, handler);
      resolve(data);
    };
    addListener(port, handler);
  });
}

function addListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.on === "function") {
    port.on("message", handler);
    return;
  }
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = (ev) => {
      handler(ev as MessageEvent<unknown>);
    };
    (handler as unknown as { __listener?: EventListener }).__listener = listener;
    port.addEventListener("message", listener);
    port.start?.();
  }
}

function removeListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.off === "function") {
    port.off("message", handler);
    return;
  }
  if (typeof port.removeEventListener === "function") {
    const listener = (handler as unknown as { __listener?: EventListener }).__listener;
    if (listener) port.removeEventListener("message", listener);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageEvent(value: unknown): value is MessageEvent<unknown> {
  return isRecord(value) && "data" in value;
}

function isSabSetupMessage(value: unknown): value is SabSetupMessage {
  return isRecord(value) && value.t === SAB_SETUP && "setup" in value;
}

function isSabAckMessage(value: unknown): value is SabAckMessage {
  return isRecord(value) && value.t === SAB_ACK;
}


