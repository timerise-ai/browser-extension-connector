# The offline buffer, the lane and routing

Three small pure modules the worker is built on. All three have tests
([tests.md](tests.md)).

## Why bounded, and why loud

`chrome.storage.local` is about 10 MB and `unlimitedStorage` is deliberately
not requested. An unbounded queue is not a safer place to lose data, only a
quieter one. So the buffer caps, drops the **oldest**, and **counts the drop**;
the count rides every post into the host's `dropped` counter and onto the
connection card. An install silently discarding a third of someone's data must
not look identical to a healthy one.

Nothing is lost by dropping in the ordinary case: a host-directed pull is
cursor-driven and re-fetches, and a live record is re-observed the next time
the page loads it. The count is what tells an operator whether that held.

## src/background/queue.ts

```ts
// extension/src/background/queue.ts
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
```

Three properties, each the fix for a real loss:

| Property | The loss it prevents |
|---|---|
| Every mutation through one `Serial` | the tap fires several pushes per screen while the loop acks a batch; overlapping read-modify-writes kept whichever finished last |
| `ack` by identity, not "first N" | records queued while the post was in flight were silently discarded |
| `ack` by version (`queuedAt`) as well | a record re-observed mid-flight is a newer copy the host has not seen; acking its predecessor lost the update |
| In-memory cache dropped on a failed write | a quota error left the cache claiming records storage never took |

De-duplication on `(kind, externalId)` inside the buffer is an optimisation
(a user scrolling one list re-fetches the same page repeatedly); the host
de-duplicates again on content, and that is the guarantee.

## src/shared/serial.ts

```ts
// extension/src/shared/serial.ts
/**
 * A one-lane queue for async work.
 *
 * `chrome.storage.local` has no transactions, so every "read, change, write
 * back" races every other one, and the tap fires several at once each time
 * the page loads a screen, while the sync loop is acknowledging a batch. Two
 * overlapping read-modify-writes keep whichever finished last and silently
 * lose the other's records. For a tapped record that is a delay (it is
 * re-observed); for a pulled page it is a hole, because the cursor advances
 * regardless.
 *
 * Kept alone and pure so both the queue and the loop can use it, and so the
 * ordering guarantee can be tested without a browser.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Runs `task` after everything queued before it, and returns its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const next = this.tail.then(task, task).finally(() => {
      this.depth -= 1;
    });
    // The chain must never reject, or every later task would be skipped.
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** How many tasks are running or waiting. Zero means idle. */
  get pending(): number {
    return this.depth;
  }
}
```

The chain must never reject, or every later task is skipped. Hence the
`.catch(() => undefined)` on the tail while the caller still gets the
rejection.

## src/background/routing.ts

```ts
// extension/src/background/routing.ts
/**
 * Which connection a queued record belongs to.
 *
 * One browser may be paired with several connections (two accounts on one
 * service, or two services) and they share one offline buffer, because the
 * tap that fills it does not know who is paired. Without this the loop handed
 * each connection the next slice of the buffer, so two accounts' records were
 * dealt out between their connections more or less at random.
 *
 * The rule is the account id. Every record is tagged with the account it was
 * observed under, and every pairing is bound to one account by the host, which
 * learned it from this extension's first post and hands it back on every poll.
 * A record goes only to the pairing bound to its account.
 *
 * Two edges, both deliberate: a pairing the host has not bound yet routes as
 * whatever the page currently shows (pairing while looking at the right account
 * is how a person naturally does it); and an untagged record goes to the first
 * pairing, which in the one-connection case is the only one.
 *
 * Pure, so the rule can be tested without booting the service worker.
 */

export type Routable = { connectionId: string; accountId?: string | null };

/** The account a pairing carries records for: bound by the host, else the one on screen. */
export function accountFor(pairing: Routable, observed: string | null): string | null {
  return pairing.accountId ?? observed;
}

/** Whether `pairing` should post this record. */
export function accepts(
  pairing: Routable,
  record: { accountId?: string | null },
  pairings: readonly Routable[],
  observed: string | null,
): boolean {
  const tag = record.accountId ?? null;
  if (tag === null) return pairings[0]?.connectionId === pairing.connectionId;
  return accountFor(pairing, observed) === tag;
}

/**
 * Whether a record can never be posted from this browser: tagged with an
 * account no pairing is bound to, once every pairing *is* bound. While any
 * pairing is still unbound the record is kept: that pairing may yet bind to
 * exactly this account on its first post.
 */
export function orphaned(
  record: { accountId?: string | null },
  pairings: readonly Routable[],
  observed: string | null,
): boolean {
  const tag = record.accountId ?? null;
  if (tag === null || pairings.length === 0) return false;
  if (pairings.some((p) => !p.accountId)) return false;
  return !pairings.some((p) => accountFor(p, observed) === tag);
}
```

One browser may be paired to two accounts on one service. They share one
buffer, because the tap does not know who is paired. Before routing existed the
loop handed each connection the next slice of the buffer, and two accounts'
records were dealt out between their connections at random. Every record is
tagged with the account it was observed under; every pairing is bound to one
account by the host; a record goes only to the pairing bound to its account.

The two edges are deliberate: an unbound pairing routes as whatever the page
currently shows (pairing while looking at the right account is how a person
naturally does it), and an untagged record goes to the first pairing, which in
the one-connection case is the only one.

## Storage keys

| Key | Holds | Written by |
|---|---|---|
| `connector.pairings` | `Pairing[]` | options page, engine (`bindPairing`) |
| `connector.lastPost` | `Record<connectionId, LastPost>` | engine |
| `connector.queue` | `QueuedRecord[]` | queue |
| `connector.dropped` | number | queue |
| `connector.accountId` | string | engine |

Nothing else is stored. In particular, no service credential, ever.

## Checklist

- [ ] `MAX_QUEUE_ITEMS` sized to leave headroom under 10 MB for your record size
- [ ] Drop count reported and cleared only after a successful post
- [ ] Every read-modify-write on storage inside the lane
- [ ] Records tagged with the account at push time
