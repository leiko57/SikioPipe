export type MessagePortLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  start?: () => void;
  close?: () => void;
};

export type MessageChannelLike = {
  port1: MessagePortLike;
  port2: MessagePortLike;
};

export async function createMessageChannel(): Promise<MessageChannelLike> {
  if (typeof MessageChannel === "function") {
    return new MessageChannel();
  }
  const mod = await import("node:worker_threads");
  return new mod.MessageChannel();
}


