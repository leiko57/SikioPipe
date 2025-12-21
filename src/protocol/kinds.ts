export const MessageKind = {
  Data: 1,
  RpcCall: 2,
  RpcResolve: 3,
  RpcReject: 4,
  RpcCancel: 10,
  StreamPush: 5,
  StreamEnd: 6,
  StreamCredit: 7,
  StreamCancel: 8,
  TransportReturnBuffer: 9,
  ControlPing: 11,
  ControlPong: 12,
  ControlClose: 13,
} as const;

export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];


