import type { Store } from "../src/background/queue";

/** An in-memory stand-in for the slice of `chrome.storage.local` the queue uses. */
export function memoryStore(): Store & { dump(): Record<string, unknown> } {
  const bag: Record<string, unknown> = {};
  return {
    async get<T>(key: string) {
      return bag[key] as T | undefined;
    },
    async set(key, value) {
      bag[key] = value;
    },
    dump: () => bag,
  };
}
