export function throwIfAborted(signal?: AbortSignal) {
  if (!signal) return;
  if (!signal.aborted) return;
  throw abortError();
}

export function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(abortError()),
      { once: true },
    );
  });
}

export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}


