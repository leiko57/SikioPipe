export function asyncIterableFromReadableStream<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      let done = false;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            done = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!done) {
          try {
            await reader.cancel();
          } catch (err) {
            void err;
          }
        }
        reader.releaseLock();
      }
    },
  };
}

export function readableStreamFromAsyncIterable<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch (err) {
          void err;
        }
      }
    },
  });
}
