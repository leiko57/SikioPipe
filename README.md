# SikioPipe (beta)

![NPM Version](https://img.shields.io/npm/v/sikiopipe?style=flat-square&color=blue) ![License](https://img.shields.io/github/license/leiko57/SikioPipe?style=flat-square) ![TypeScript](https://img.shields.io/badge/built_with-TypeScript-3178c6?style=flat-square) ![Targets](https://img.shields.io/badge/targets-web%20workers%20%7C%20worker_threads-purple?style=flat-square)

Zero‑copy‑ish IPC & RPC between Web Workers and Node.js `worker_threads` with a SharedArrayBuffer + Atomics fast path and `postMessage` fallback.

## Features

- **SAB + Atomics fast path**: Uses SharedArrayBuffer-backed SPSC rings with a pooled block allocator when eligible.
- **Fallback transport**: Falls back to `postMessage` when SAB isn't available or allowed.
- **Channels**: Send raw `Uint8Array` frames, with borrowed receives for low-copy hot paths.
- **RPC**: Type-safe-ish remote proxies (`rpc(conn).wrap<T>()`) with a tiny server (`rpc(conn).expose(...)`).
- **Streaming RPC**: `AsyncIterable<Uint8Array>` arguments and return values are streamed with backpressure.
- **Configurable**: `mode`, `blockSize`, `blockCount`, handshake timeout, ping intervals.
- **Pluggable codec**: MessagePack by default, custom encode/decode supported.
- **Large frame chunking**: Payloads larger than transport capacity are chunked and reassembled.

## Requirements

- Node.js >= 20 for `worker_threads`.
- ESM-only package. `spawnWorker` uses module workers in both Node.js and browsers.

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
conn.terminate();
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
conn.terminate();
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

## Streaming RPC

Pass `AsyncIterable<Uint8Array>` as arguments or return values for streamed data with backpressure:

`main.ts`

```ts
import { spawnWorker, rpc } from "sikiopipe/node";

type Api = {
  hash(chunks: AsyncIterable<Uint8Array>): Promise<string>;
  generate(count: number): AsyncIterable<Uint8Array>;
};

const conn = await spawnWorker(new URL("./worker.js", import.meta.url));
const api = rpc(conn).wrap<Api>();

async function* source() {
  yield new Uint8Array([1, 2, 3]);
  yield new Uint8Array([4, 5, 6]);
}

console.log(await api.hash(source()));

for await (const chunk of api.generate(10)) {
  console.log(chunk);
}

conn.close();
conn.terminate();
```

`worker.js`

```ts
import { acceptConnection, rpc } from "sikiopipe/node";

const conn = await acceptConnection();
rpc(conn).expose({
  async hash(chunks: AsyncIterable<Uint8Array>) {
    let total = 0;
    for await (const chunk of chunks) {
      total += chunk.byteLength;
    }
    return `received ${total} bytes`;
  },
  async *generate(count: number) {
    for (let i = 0; i < count; i++) {
      yield new Uint8Array([i]);
    }
  },
});
```

For borrowed stream chunks:

- Use `rpc(conn).wrapBorrowed<T>()` to receive borrowed chunks for streamed return values.
- Set `streamBorrowed: true` on the receiver to get borrowed chunks for streamed arguments.

## Web Streams helpers

```ts
import { asyncIterableFromReadableStream, readableStreamFromAsyncIterable } from "sikiopipe";

const iterable = asyncIterableFromReadableStream(stream);
const stream2 = readableStreamFromAsyncIterable(iterable);
```

## Transports

| Mode | Behavior | Notes |
|------|----------|-------|
| `auto` | Selects SAB when eligible, otherwise `postMessage` | Default |
| `sab` | Forces SAB transport | Requires cross-origin isolation in browsers |
| `postMessage` | Forces `postMessage` transport | Always available |

Payloads larger than the transport capacity are automatically chunked and reassembled.

### SAB Requirements (Browser)

To use SAB transport in browsers, your server must send these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: cross-origin-isolated
```

`Cross-Origin-Embedder-Policy: credentialless` also works if it fits your deployment.

Check eligibility at runtime:

```ts
import { getSabEligibility } from "sikiopipe/browser";

const status = getSabEligibility();
console.log(status.eligible, status.reasons, status.policyHints);
```

## Options

### Connection Options

```ts
const conn = await spawnWorker(url, {
  mode: "auto",              // "auto" | "sab" | "postMessage"
  blockSize: 64 * 1024,      // SAB block size (bytes), postMessage uses 8KB default
  blockCount: 64,            // number of blocks (must be power of 2)
  handshakeTimeoutMs: 5000,  // handshake timeout
  pingIntervalMs: 30000,     // heartbeat interval (0 to disable)
  pingTimeoutMs: 5000,       // ping timeout before disconnect
});
```

### RPC Options

```ts
const client = rpc(conn, {
  codec: defaultCodec,
  streamWindow: 8,           // backpressure window size
  callTimeoutMs: 0,          // call timeout (0 = no timeout)
  streamBorrowed: false,     // use borrowed buffers for inbound streams
});
```

## Codecs

RPC uses MessagePack by default (`defaultCodec`). To override it, provide a custom codec:

```ts
import { rpc } from "sikiopipe";

const codec = {
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
};

const api = rpc(conn, { codec }).wrap();
```

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

## Cancellation

Pass `AbortSignal` in the last argument for cancellation:

```ts
const controller = new AbortController();

api.slowMethod(arg1, arg2, { signal: controller.signal });

controller.abort();
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


