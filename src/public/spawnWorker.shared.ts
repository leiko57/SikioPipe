export type SpawnWorkerOptions = {
  mode?: "auto" | "sab" | "postMessage";
  blockSize?: number;
  blockCount?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
};
