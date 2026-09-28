import { beforeEach, describe, expect, it } from "vitest";
import { MAX_RECORDS_PER_BATCH, type ConnectorRecord } from "../src/wire";
import { QUEUE_KEY, RecordQueue, type Store } from "../src/background/queue";
import { MAX_RECORDS_PER_POST } from "../src/background/constants";
import { memoryStore } from "./helpers";

function item(id: string, name = `Item ${id}`): ConnectorRecord {
  return { kind: "item", externalId: id, payload: { name } };
}

describe("RecordQueue", () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
  });

  it("starts empty", async () => {
    const q = new RecordQueue(store);
    expect(await q.all()).toEqual([]);
    expect(await q.droppedCount()).toBe(0);
  });

  it("keeps what it is given, oldest first", async () => {
    const q = new RecordQueue(store);
    await q.push([item("1")]);
    await q.push([item("2")]);
    expect((await q.all()).map((r) => r.externalId)).toEqual(["1", "2"]);
  });

  it("collapses repeats of the same record, newest content winning", async () => {
    const q = new RecordQueue(store);
    await q.push([item("1", "Anna")]);
    await q.push([item("1", "Anna Nowak")]);
    const all = await q.all();
    expect(all).toHaveLength(1);
    expect((all[0]?.payload as { name: string }).name).toBe("Anna Nowak");
  });

  it("keeps records of different kinds with the same id apart", async () => {
    const q = new RecordQueue(store);
    await q.push([item("1"), { kind: "other", externalId: "1", payload: {} }]);
    expect(await q.size()).toBe(2);
  });

  describe("when full", () => {
    it("drops the oldest and counts the drop", async () => {
      const q = new RecordQueue(store, 3);
      await q.push([item("1"), item("2"), item("3")]);
      await q.push([item("4"), item("5")]);
      expect((await q.all()).map((r) => r.externalId)).toEqual(["3", "4", "5"]);
      expect(await q.droppedCount()).toBe(2);
    });

    it("accumulates the drop count across several overflows", async () => {
      const q = new RecordQueue(store, 2);
      await q.push([item("1"), item("2"), item("3")]);
      await q.push([item("4")]);
      expect(await q.droppedCount()).toBe(2);
    });

    it("forgets the count only once it has been reported", async () => {
      const q = new RecordQueue(store, 1);
      await q.push([item("1"), item("2")]);
      expect(await q.droppedCount()).toBe(1);
      await q.clearDropped(1);
      expect(await q.droppedCount()).toBe(0);
    });

    /** Zeroing once the post returned lost whatever overflowed while it was in flight. */
    it("keeps drops counted while the report was in flight", async () => {
      const q = new RecordQueue(store, 1);
      await q.push([item("1"), item("2")]);
      const reported = await q.droppedCount();
      await q.push([item("3")]);
      await q.clearDropped(reported);
      expect(await q.droppedCount()).toBe(1);
    });
  });

  describe("ack", () => {
    it("removes exactly what was sent", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1"), item("2"), item("3")]);
      const batch = await q.peek(2);
      await q.ack(batch);
      expect((await q.all()).map((r) => r.externalId)).toEqual(["3"]);
    });

    /** Acknowledging "the first two" instead of "these two" silently discards what arrived mid-flight. */
    it("does not discard records that arrived during the post", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1"), item("2")]);
      const batch = await q.peek(2);
      await q.push([item("9")]);
      await q.ack(batch);
      expect((await q.all()).map((r) => r.externalId)).toEqual(["9"]);
    });

    it("is a no-op for an empty acknowledgement", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1")]);
      await q.ack([]);
      expect(await q.size()).toBe(1);
    });

    /** A record re-observed between the peek and the ack is a newer copy the host has not seen. */
    it("keeps a record re-observed with newer content during the post", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1", "Anna")]);
      const batch = await q.peek(1);
      await new Promise((r) => setTimeout(r, 2));
      await q.push([item("1", "Anna Nowak")]);
      await q.ack(batch);
      const all = await q.all();
      expect(all).toHaveLength(1);
      expect((all[0]?.payload as { name: string }).name).toBe("Anna Nowak");
    });
  });

  /** Without the lane the last write won and the others' records vanished. */
  it("loses nothing when pushes and an ack overlap", async () => {
    const q = new RecordQueue(store);
    await q.push([item("sent")]);
    const batch = await q.peek(1);
    await Promise.all([q.push([item("a")]), q.ack(batch), q.push([item("b")]), q.push([item("c")])]);
    expect((await q.all()).map((r) => r.externalId).sort()).toEqual(["a", "b", "c"]);
    expect(((store.dump()[QUEUE_KEY] as unknown[]) ?? []).length).toBe(3);
  });

  it("recovers from a write that fails, rather than trusting its own copy", async () => {
    let fail = false;
    const flaky: Store = {
      get: (key) => store.get(key),
      async set(key, value) {
        if (fail) throw new Error("QUOTA_BYTES exceeded");
        await store.set(key, value);
      },
    };
    const q = new RecordQueue(flaky);
    await q.push([item("1")]);
    fail = true;
    await expect(q.push([item("2")])).rejects.toThrow("QUOTA");
    fail = false;
    expect((await q.all()).map((r) => r.externalId)).toEqual(["1"]);
  });

  describe("routing by account", () => {
    it("tags what it is given and lets a peek filter on it", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1")], "100");
      await q.push([item("2")], "200");
      await q.push([item("3")]);
      expect((await q.peek(10, (r) => r.accountId === "100")).map((r) => r.externalId)).toEqual(["1"]);
      expect((await q.peek(10, (r) => r.accountId == null)).map((r) => r.externalId)).toEqual(["3"]);
    });

    it("discards on request without counting a drop", async () => {
      const q = new RecordQueue(store);
      await q.push([item("1")], "100");
      await q.push([item("2")], "300");
      expect(await q.discard((r) => r.accountId === "300")).toBe(1);
      expect((await q.all()).map((r) => r.externalId)).toEqual(["1"]);
      expect(await q.droppedCount()).toBe(0);
    });
  });

  it("peeks without removing", async () => {
    const q = new RecordQueue(store);
    await q.push([item("1"), item("2")]);
    expect(await q.peek(1)).toHaveLength(1);
    expect(await q.size()).toBe(2);
  });
});

describe("batch size", () => {
  /** The two constants are declared separately (type-only wire import) and could drift. */
  it("never exceeds what the host will accept", () => {
    expect(MAX_RECORDS_PER_POST).toBeLessThanOrEqual(MAX_RECORDS_PER_BATCH);
  });
});
