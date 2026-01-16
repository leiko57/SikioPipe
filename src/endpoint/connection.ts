import { createMessageChannel } from "../internal/messageChannel.js";
import { MessageKind } from "../protocol/kinds.js";
import { createTransport, type Transport, type TransportKind } from "../transport/createTransport.js";
import { FrameRouter } from "./router.js";

export type ConnectOptions = {
  mode?: "auto" | "sab" | "postMessage";
  blockSize?: number;
  blockCount?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
};

export type Connection = {
  readonly role: "client" | "server";
  readonly transportKind: TransportKind;
  readonly transport: Transport;
  readonly router: FrameRouter;
  close(reason?: string): void;
};

export function isNodeLike() {
  return typeof process !== "undefined" && typeof process.versions.node === "string";
}

export function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

type WorkerLike = {
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

type PortLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  start?: () => void;
  close?: () => void;
  ref?: () => void;
  unref?: () => void;
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

type GlobalWithPerformance = {
  performance?: { now?: () => number };
};

const INIT = "sikiopipe:init";
const ACK = "sikiopipe:ack";
type AckMessage = {
  t: typeof ACK;
  opts?: ConnectOptions;
  error?: { message: string };
};
const emptyPayload = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function connectToWorkerLike(worker: WorkerLike, opts: ConnectOptions): Promise<Connection> {
  const channel = await createMessageChannel();
  worker.postMessage({ t: INIT, port: channel.port1, opts }, [channel.port1]);

  const port = channel.port2;
  port.start?.();

  let ackOpts: ConnectOptions | undefined;
  try {
    ackOpts = await waitForAck(port, opts.handshakeTimeoutMs);
  } catch (e) {
    port.close?.();
      const terminate = (worker as unknown as { terminate?: () => unknown }).terminate;
      if (typeof terminate === "function") {
        try {
          await terminate.call(worker);
        } catch (err) {
          void err;
        }
      }
    throw e;
  }
  const transport = await createTransport(port, "client", ackOpts ?? opts);
  const connectionOpts = mergeLocalOptions(opts, ackOpts ?? opts);
  return createConnection("client", transport, port, connectionOpts);
}

export async function acceptConnection(opts: ConnectOptions = {}): Promise<Connection> {
  const init = await waitForInitAndGetPort(opts);
  const port = init.port;
  port.start?.();

  const effectiveOpts = mergeOptions(opts, init.opts);
  port.postMessage({ t: ACK, opts: effectiveOpts });
  const transport = await createTransport(port, "server", effectiveOpts);
  return createConnection("server", transport, port, effectiveOpts);
}

export async function connect(port: PortLike, opts: ConnectOptions = {}): Promise<Connection> {
  const transport = await createTransport(port, "client", opts);
  return createConnection("client", transport, port, opts);
}

function waitForAck(port: PortLike, timeoutMs?: number): Promise<ConnectOptions | undefined> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        removePortListener(port, handler);
        reject(new Error("Handshake timeout"));
      }, timeoutMs);
    }
    const handler = (value: unknown) => {
      if (isMessageEvent(value)) {
        const data = value.data;
        if (isObj(data) && data.t === ACK) {
          const msg = data as AckMessage;
          removePortListener(port, handler);
          if (timeoutId) clearTimeout(timeoutId);
          if (msg.error?.message) {
            reject(new Error(msg.error.message));
            return;
          }
          resolve(msg.opts);
        }
        return;
      }
      if (isObj(value) && value.t === ACK) {
        const msg = value as AckMessage;
        removePortListener(port, handler);
        if (timeoutId) clearTimeout(timeoutId);
        if (msg.error?.message) {
          reject(new Error(msg.error.message));
          return;
        }
        resolve(msg.opts);
      }
    };
    addPortListener(port, handler);
  });
}

function waitForInitAndGetPort(opts: ConnectOptions): Promise<{ port: PortLike; opts?: ConnectOptions }> {
  return new Promise((resolve) => {
    const handler = (value: unknown) => {
      if (isMessageEvent(value)) {
        const data = value.data;
        if (isObj(data) && data.t === INIT) {
          const port = (data as { port: PortLike }).port;
          const initOpts = (data as { opts?: ConnectOptions }).opts;
          removeGlobalListener(handler);
          resolve(initOpts ? { port, opts: initOpts } : { port });
        }
        return;
      }
      if (isObj(value) && value.t === INIT) {
        const port = (value as { port: PortLike }).port;
        const initOpts = (value as { opts?: ConnectOptions }).opts;
        removeGlobalListener(handler);
        resolve(initOpts ? { port, opts: initOpts } : { port });
      }
    };
    addGlobalListener(handler, opts);
  });
}

function mergeOptions(server: ConnectOptions, client?: ConnectOptions): ConnectOptions {
  const mode = server.mode ?? client?.mode;
  const blockSize = server.blockSize ?? client?.blockSize;
  const blockCount = server.blockCount ?? client?.blockCount;
  const out: ConnectOptions = {};
  if (mode !== undefined) out.mode = mode;
  if (blockSize !== undefined) out.blockSize = blockSize;
  if (blockCount !== undefined) out.blockCount = blockCount;
  if (server.handshakeTimeoutMs !== undefined) out.handshakeTimeoutMs = server.handshakeTimeoutMs;
  if (server.pingIntervalMs !== undefined) out.pingIntervalMs = server.pingIntervalMs;
  if (server.pingTimeoutMs !== undefined) out.pingTimeoutMs = server.pingTimeoutMs;
  return out;
}

function mergeLocalOptions(local: ConnectOptions, negotiated: ConnectOptions): ConnectOptions {
  const out: ConnectOptions = {};
  if (negotiated.mode !== undefined) out.mode = negotiated.mode;
  if (negotiated.blockSize !== undefined) out.blockSize = negotiated.blockSize;
  if (negotiated.blockCount !== undefined) out.blockCount = negotiated.blockCount;
  if (local.pingIntervalMs !== undefined) out.pingIntervalMs = local.pingIntervalMs;
  if (local.pingTimeoutMs !== undefined) out.pingTimeoutMs = local.pingTimeoutMs;
  return out;
}

function createConnection(role: "client" | "server", transport: Transport, port: PortLike, opts: ConnectOptions): Connection {
  const router = new FrameRouter(transport);
  const releasePort = keepPortAlive(port, transport.kind === "sab");
  let closed = false;
  let controlStop = () => {};
  const closeLocal = (reason?: string, sendClose?: boolean) => {
    if (closed) return;
    closed = true;
    controlStop();
    if (sendClose) void sendControlClose(router, reason);
    releasePort();
    router.close();
    transport.close();
    port.close?.();
  };
  const control = startControl(
    router,
    opts,
    (reason) => {
      closeLocal(reason, false);
    },
    () => {
      closeLocal("Ping timeout", true);
    },
  );
  controlStop = () => {
    control.stop();
  };
  return {
    role,
    transportKind: transport.kind,
    transport,
    router,
    close(reason?: string) {
      closeLocal(reason, true);
    },
  };
}

function startControl(
  router: FrameRouter,
  opts: ConnectOptions,
  onRemoteClose: (reason?: string) => void,
  onPingTimeout: () => void,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const heartbeat = startHeartbeat(router, opts, onPingTimeout, (ms) => {
    router.recordLatency(ms);
  });

  const loopPing = async () => {
    try {
      for await (const frame of router.recv(MessageKind.ControlPing, { signal })) {
        const aux = frame.aux >>> 0;
        frame.release();
        await router.send({
          kind: MessageKind.ControlPong,
          id: 0,
          streamId: 0,
          flags: 0,
          aux,
          payload: emptyPayload,
        });
      }
    } catch {
      return;
    }
  };

  const loopPong = async () => {
    try {
      for await (const frame of router.recv(MessageKind.ControlPong, { signal })) {
        const aux = frame.aux >>> 0;
        frame.release();
        heartbeat.onPong(aux);
      }
    } catch {
      return;
    }
  };

  const loopClose = async () => {
    try {
      for await (const frame of router.recv(MessageKind.ControlClose, { signal })) {
        const reason = decodeCloseReason(frame.payload);
        frame.release();
        onRemoteClose(reason);
      }
    } catch {
      return;
    }
  };

  void loopPing();
  void loopPong();
  void loopClose();

  return {
    stop() {
      heartbeat.stop();
      controller.abort();
    },
  };
}

function startHeartbeat(
  router: FrameRouter,
  opts: ConnectOptions,
  onTimeout: () => void,
  onLatency?: (ms: number) => void,
) {
  const interval = opts.pingIntervalMs ?? 0;
  const timeout = opts.pingTimeoutMs ?? 0;
  if (interval <= 0) {
    return {
      onPong() {},
      stop() {},
    };
  }
  let closed = false;
  let pingSeq = 1;
  let lastPingSeq = 0;
  let lastPingAt = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const clearTimeoutTimer = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const scheduleTimeout = () => {
    if (timeout <= 0) return;
    clearTimeoutTimer();
    timeoutId = setTimeout(() => {
      if (closed) return;
      onTimeout();
    }, timeout);
  };

  const sendPing = async () => {
    if (closed) return;
    const aux = pingSeq++ >>> 0;
    lastPingSeq = aux;
    lastPingAt = nowMs();
    await router
      .send({
        kind: MessageKind.ControlPing,
        id: 0,
        streamId: 0,
        flags: 0,
        aux,
        payload: emptyPayload,
      })
      .catch(() => {
        return undefined;
      });
    scheduleTimeout();
  };

  const intervalId = setInterval(() => {
    void sendPing();
  }, interval);

  void sendPing();

  return {
    onPong(aux?: number) {
      clearTimeoutTimer();
      if (onLatency && lastPingAt > 0 && aux === lastPingSeq) {
        onLatency(nowMs() - lastPingAt);
      }
    },
    stop() {
      closed = true;
      clearInterval(intervalId);
      clearTimeoutTimer();
    },
  };
}

function nowMs() {
  const perf = (globalThis as GlobalWithPerformance).performance;
  const now = perf?.now;
  if (typeof now === "function") return now.call(perf);
  return Date.now();
}

function encodeCloseReason(reason?: string): Uint8Array {
  if (!reason) return emptyPayload;
  return textEncoder.encode(reason);
}

function decodeCloseReason(payload: Uint8Array): string | undefined {
  if (payload.byteLength === 0) return undefined;
  return textDecoder.decode(payload);
}

async function sendControlClose(router: FrameRouter, reason?: string) {
  await router
    .send({
      kind: MessageKind.ControlClose,
      id: 0,
      streamId: 0,
      flags: 0,
      aux: 0,
      payload: encodeCloseReason(reason),
    })
    .catch(() => {
      return undefined;
    });
}

function addGlobalListener(handler: (value: unknown) => void, _opts: ConnectOptions) {
  if (typeof self !== "undefined" && typeof (self as unknown as { addEventListener?: unknown }).addEventListener === "function") {
    const listener: EventListener = (ev) => {
      handler(ev as MessageEvent<unknown>);
    };
    (handler as unknown as { __listener?: EventListener }).__listener = listener;
    (self as unknown as { addEventListener: (t: string, l: (ev: MessageEvent) => void) => void }).addEventListener("message", listener);
    return;
  }
  if (isNodeLike()) {
    const listener = (value: unknown) => {
      handler(value);
    };
    (handler as unknown as { __nodeListener?: (v: unknown) => void }).__nodeListener = listener;
    void import("node:worker_threads").then(({ parentPort }) => {
      parentPort?.on("message", listener);
    });
  }
}

function removeGlobalListener(handler: (value: unknown) => void) {
  if (typeof self !== "undefined" && typeof (self as unknown as { removeEventListener?: unknown }).removeEventListener === "function") {
    const listener = (handler as unknown as { __listener?: EventListener }).__listener;
    if (listener) {
      (self as unknown as { removeEventListener: (t: string, l: (ev: MessageEvent) => void) => void }).removeEventListener("message", listener);
    }
    return;
  }
  if (isNodeLike()) {
    const listener = (handler as unknown as { __nodeListener?: (v: unknown) => void }).__nodeListener;
    if (listener) {
      void import("node:worker_threads").then(({ parentPort }) => {
        parentPort?.off("message", listener);
      });
    }
  }
}

function addPortListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = (ev) => {
      handler(ev as MessageEvent<unknown>);
    };
    (handler as unknown as { __listener?: EventListener }).__listener = listener;
    port.addEventListener("message", listener);
    return;
  }
  port.on?.("message", handler);
}

function removePortListener(port: PortLike, handler: (value: unknown) => void) {
  if (typeof port.removeEventListener === "function") {
    const listener = (handler as unknown as { __listener?: EventListener }).__listener;
    if (listener) port.removeEventListener("message", listener);
    return;
  }
  port.off?.("message", handler);
}

function keepPortAlive(port: PortLike, enabled: boolean) {
  if (!enabled) {
    return () => {
      return undefined;
    };
  }
  const handler = () => {
    return undefined;
  };
  if (typeof port.addEventListener === "function") {
    const listener: EventListener = () => {
      return undefined;
    };
    port.addEventListener("message", listener);
    port.ref?.();
    return () => {
      port.removeEventListener?.("message", listener);
      port.unref?.();
    };
  }
  if (typeof port.on === "function") {
    port.on("message", handler);
    port.ref?.();
    return () => {
      port.off?.("message", handler);
      port.unref?.();
    };
  }
  port.ref?.();
  return () => {
    port.unref?.();
  };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageEvent(value: unknown): value is MessageEvent<unknown> {
  return isObj(value) && "data" in value;
}


