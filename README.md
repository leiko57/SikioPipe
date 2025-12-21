# SikioPipe

![NPM Version](https://img.shields.io/npm/v/sikiopipe?style=flat-square&color=blue) ![License](https://img.shields.io/github/license/leiko57/SikioPipe?style=flat-square) ![TypeScript](https://img.shields.io/badge/built_with-TypeScript-3178c6?style=flat-square) ![Targets](https://img.shields.io/badge/targets-web%20workers%20%7C%20worker_threads-purple?style=flat-square) ![Size](https://img.shields.io/bundlephobia/minzip/sikiopipe?style=flat-square&label=minzipped)

Zero‑copy‑ish IPC & RPC between Web Workers and Node.js `worker_threads` with a SharedArrayBuffer + Atomics fast path and `postMessage` fallback.

## Features

- **SAB + Atomics fast path**: Uses SharedArrayBuffer-backed SPSC rings with a pooled block allocator when eligible.
- **Fallback transport**: Falls back to `postMessage` when SAB isn’t available or allowed.
- **Channels**: Send raw `Uint8Array` frames, with borrowed receives for low-copy hot paths.
- **RPC**: Type-safe-ish remote proxies (`rpc(conn).wrap<T>()`) with a tiny server (`rpc(conn).expose(...)`).
- **Streaming RPC**: `AsyncIterable<Uint8Array>` arguments and return values are streamed with backpressure.
- **Configurable**: `mode`, `blockSize`, `blockCount`, handshake timeout, ping intervals.

## Installation

```bash
npm i sikiopipe
```

or

```bash
pnpm add sikiopipe
```

or

```bash
yarn add sikiopipe
```

## Quick Start

### Node.js (`worker_threads`)

`main.ts`

```ts
import { spawnWorker, rpc } from "sikiopipe/node";

type Api = {
  add(a: number, b: number): number;
};

const conn = await spawnWorker(new URL("./worker.js", import.meta.url));
const api = rpc(conn).wrap<Api>();

console.log(await api.add(1, 2));

conn.close();
await conn.terminate();
```

`worker.js`

```ts
import { acceptConnection, rpc } from "sikiopipe/node";

const conn = await acceptConnection();
rpc(conn).expose({
  add(a: number, b: number) {
    return a + b;
  },
});
```

### Browser (Web Workers)

`main.ts`

```ts
import { getSabEligibility, rpc, spawnWorker } from "sikiopipe/browser";

console.log(getSabEligibility());

type Api = {
  ping(): string;
};

const conn = await spawnWorker(new URL("./worker.js", import.meta.url));
const api = rpc(conn).wrap<Api>();

console.log(await api.ping());

conn.close();
await conn.terminate();
```

`worker.js`

```ts
import { acceptConnection, rpc } from "sikiopipe/browser";

const conn = await acceptConnection();
rpc(conn).expose({
  ping() {
    return "pong";
  },
});
```

## Transports

| Mode | Behavior | Notes |
|------|----------|-------|
| `auto` | Selects SAB when eligible, otherwise `postMessage` | Default |
| `sab` | Forces SAB transport | In browsers requires COOP/COEP (cross-origin isolation) |
| `postMessage` | Forces `postMessage` transport | Always available |

## Zero-copy-ish data path

Borrowed receive (avoid per-message `slice()` allocations):

```ts
import { channel } from "sikiopipe";

const ch = channel(conn);

for await (const chunk of ch.recvBorrowed()) {
  try {
    onBytes(chunk.bytes);
  } finally {
    chunk.release();
  }
}
```

Transfer-backed send (only on `postMessage` transport):

```ts
import { channel, createTransferPayload } from "sikiopipe";

const ch = channel(conn);

const data = new Uint8Array([1, 2, 3]);
const { payload } = createTransferPayload(data.byteLength);
payload.set(data);

await ch.sendTransfer(payload);
```

## Building from Source

```bash
npm install
npm run build
```

## Contributing

Found a bug or have a feature request? Open an [Issue](https://github.com/leiko57/SikioPipe/issues/new).
PRs are welcome!

## License

This project is licensed under AGPLv3 (`AGPL-3.0-only`).


