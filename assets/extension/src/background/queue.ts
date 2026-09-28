import type { ConnectorRecord } from "../wire";
import { Serial } from "../shared/serial";

/**
 * The offline buffer.
 *
 * A machine loses its network, gets closed at 18:00, or the host is
 * mid-deploy. Records observed in the meantime wait in `chrome.storage.local`,
 * about 10 MB and deliberately not raised: `unlimitedStorage` is a
 * permission we do not want on the listing, and an unbounded queue is not a
 * safer place to lose data, only a quieter one.
 *
 * So the queue is **bounded and loud**. When full it drops the oldest and
 * counts the drop, and that count rides every post to the host. An install
 * quietly discarding a third of someone's data must not look identical to a
 * healthy one, which is exactly what it would look like if the drop were silent.
 *
 * Nothing is lost by dropping, in the ordinary case: a host-directed pull is
 * cursor-driven from the host and simply re-fetches, and a live record is
 * re-observed the next time the page loads it. The count tells an operator
 * whether that assumption held.
 *
 * Every mutation runs through one `Serial` (storage has no transactions; the
 * tap fires several pushes at once while the loop acks a batch). The buffer is
 * held in memory once read (only this worker touches these keys) and a write
 * that fails (quota, mostly) discards the copy so the next read starts from
 * what storage actually holds.
 */

export const QUEUE_KEY = "connector.queue";
export const DROPPED_KEY = "connector.dropped";

/** Roughly 6 MB of records, leaving headroom for the token and cursors. */
export const MAX_QUEUE_ITEMS = 2_000;

export type QueuedRecord = ConnectorRecord & {
  queuedAt: number;
  /** The account the record was observed under, when known. See `routing.ts`. */
  accountId?: string | null;
};

/** The slice of `chrome.storage.local` this module needs, injectable for tests. */
export type Store = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

export function chromeStore(): Store {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const bag = await chrome.storage.local.get(key);
      return bag[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}

/** Identity of a record for de-duplication inside the buffer. */
export function identity(r: ConnectorRecord): string {
  return `${r.kind}:${r.externalId}`;
}

export class RecordQueue {
  private readonly lane = new Serial();
  private cache: QueuedRecord[] | null = null;

  constructor(
    private readonly store: Store,
    private readonly max = MAX_QUEUE_ITEMS,
  ) {}

  private async load(): Promise<QueuedRecord[]> {
    if (this.cache === null) this.cache = (await this.store.get<QueuedRecord[]>(QUEUE_KEY)) ?? [];
    return this.cache;
  }

  private async save(next: QueuedRecord[]): Promise<void> {
    try {
      await this.store.set(QUEUE_KEY, next);
      this.cache = next;
    } catch (err) {
      this.cache = null;
      throw err;
    }
  }

  async all(): Promise<QueuedRecord[]> {
    return this.lane.run(async () => [...(await this.load())]);
  }

  async droppedCount(): Promise<number> {
    return (await this.store.get<number>(DROPPED_KEY)) ?? 0;
  }

  /**
   * Add records, newest wins.
   *
   * De-duplicating on `(kind, externalId)` before the buffer fills is what
   * makes the tap cheap: a user scrolling a list re-fetches the same page
   * repeatedly, and without this a quiet afternoon would evict a morning's
   * real data with copies of one screen. The host de-duplicates again on
   * content, so this is an optimisation, not the guarantee.
   */
  async push(records: readonly ConnectorRecord[], accountId: string | null = null): Promise<void> {
    if (records.length === 0) return;
    await this.lane.run(async () => {
      const current = await this.load();
      const byIdentity = new Map<string, QueuedRecord>();
      for (const r of current) byIdentity.set(identity(r), r);
      const queuedAt = Date.now();
      for (const r of records) byIdentity.set(identity(r), { ...r, queuedAt, accountId });

      const merged = [...byIdentity.values()].sort((a, b) => a.queuedAt - b.queuedAt);
      const overflow = Math.max(0, merged.length - this.max);
      if (overflow > 0) await this.store.set(DROPPED_KEY, (await this.droppedCount()) + overflow);

      // Oldest first: a record from four hours ago has almost certainly been
      // re-observed since, while the one that just arrived has not.
      await this.save(merged.slice(overflow));
    });
  }

  /**
   * The next batch to post, oldest first. Does not remove anything. `accept`
   * narrows the batch to the records one connection may carry, in a browser
   * paired twice, the other connection's records are skipped over, not consumed.
   */
  async peek(limit: number, accept: (record: QueuedRecord) => boolean = () => true): Promise<QueuedRecord[]> {
    return this.lane.run(async () => {
      const out: QueuedRecord[] = [];
      for (const r of await this.load()) {
        if (out.length >= limit) break;
        if (accept(r)) out.push(r);
      }
      return out;
    });
  }

  /**
   * Remove records the host acknowledged.
   *
   * Explicitly not "drop the first N": while the post was in flight the tap
   * may have queued more, and by identity we remove exactly what was sent.
   * And by **version** as well as identity: a record re-observed mid-flight has
   * a newer `queuedAt` than the copy that was posted, and it is the newer copy
   * the host has not seen.
   */
  async ack(sent: readonly (ConnectorRecord & { queuedAt?: number })[]): Promise<void> {
    if (sent.length === 0) return;
    await this.lane.run(async () => {
      const acked = new Map<string, number>();
      for (const r of sent) acked.set(identity(r), r.queuedAt ?? Number.POSITIVE_INFINITY);
      const remaining = (await this.load()).filter((r) => {
        const version = acked.get(identity(r));
        return version === undefined || r.queuedAt > version;
      });
      await this.save(remaining);
    });
  }

  /**
   * Discard records nobody will ever post: those observed under an account no
   * pairing in this browser is bound to. Not counted as dropped: they were
   * never this connection's to send.
   */
  async discard(where: (record: QueuedRecord) => boolean): Promise<number> {
    return this.lane.run(async () => {
      const current = await this.load();
      const remaining = current.filter((r) => !where(r));
      const gone = current.length - remaining.length;
      if (gone > 0) await this.save(remaining);
      return gone;
    });
  }

  /**
   * Called once `reported` drops have reached the host, so they are not counted
   * twice. Subtracts rather than zeroes, inside the lane: a push that overflowed
   * while the post was in flight counted more, and zeroing lost them unreported.
   */
  async clearDropped(reported: number): Promise<void> {
    return this.lane.run(async () => {
      await this.store.set(DROPPED_KEY, Math.max(0, (await this.droppedCount()) - reported));
    });
  }

  async size(): Promise<number> {
    return this.lane.run(async () => (await this.load()).length);
  }
}
