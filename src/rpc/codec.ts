import { Decoder, Encoder } from "@msgpack/msgpack";

export type Codec = {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
};

const encoder = new Encoder();
const decoder = new Decoder();

export const defaultCodec: Codec = {
  encode(value) {
    return encoder.encode(value);
  },
  decode(bytes) {
    return decoder.decode(bytes);
  },
};


