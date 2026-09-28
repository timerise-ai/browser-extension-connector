# The sync engine

Everything the worker does that is not Chrome plumbing, as one class with
injected dependencies. `index.ts` constructs it; the tests construct it with
fakes ([tests.md](tests.md)). The diagnostics screen drives it from outside,
[diagnostics.md](diagnostics.md).

## Behaviour contract

| Situation | Behaviour |
|---|---|
| Tick fires while a pass is running | skipped, not queued: a slow pull page must not stack up ticks |
| Host answers 401 | `UnauthorizedError`; the pairing is marked revoked where the popup reads; no retry |
| Host does not answer | error and acks put back for the next attempt; `notBefore` set from the client's backoff; recorded as a failed post |
| Host answers, any post | account bound, **commands run**, pull step if directed, cadence updated |
| Command kind unknown to this build | left unacknowledged so the lease expires and a newer build gets it |
| Command with no account known | acked as failed: we do not know whose data we would touch |
| Adapter has no `execute` | commands left unacknowledged |
| Pull page fails | reported in `error`, cursor untouched on the host, retried next tick from the same place |
| Pull page partial (`page.error`) | records kept, reason reported, host retries |
| Batch retried | same `batchId` as the first attempt |
| Records for an account nobody is paired with | discarded once every pairing is bound; not counted as dropped |

## src/background/engine.ts

```ts
// extension/src/background/engine.ts
import type { Ack, Command, ConnectorRecord, SyncResponse } from "../wire";
import type { ConnectorAdapter, Observed, ServiceHttp } from "../adapters/types";
import type { RelayStatusResult } from "../shared/messages";
import { Serial } from "../shared/serial";
import { t } from "../shared/strings";
import { SyncClient, UnauthorizedError, type SyncPayload } from "./client";
import type { LastPost, Pairing } from "./config";
import { MAX_RECORDS_PER_POST } from "./constants";
import { identity, type QueuedRecord, type RecordQueue, type Store } from "./queue";
import { accepts, accountFor, orphaned } from "./routing";

/**
 * The sync engine: everything the service worker does that is not Chrome
 * plumbing. Constructed with its dependencies so it can be driven in a test
 * without a browser; `index.ts` wires it to `chrome.*`.
 */
export type EngineDeps = {
  queue: RecordQueue;
  store: Store;
  adapters: readonly ConnectorAdapter[];
  loadPairings(): Promise<Pairing[]>;
  bindPairing(connectionId: string, accountId: string): Promise<void>;
  recordLastPost(connectionId: string, outcome: LastPost): Promise<void>;
  loadLastPosts(): Promise<Record<string, LastPost>>;
  /** A request performed in the service page's session, through the relay. */
  http: ServiceHttp;
  /** What the open service tab can vouch for; `null` when none is open. */
  relayStatus(): Promise<RelayStatusResult | null>;
  /** The host asked for a different cadence. */
  onPollMs(ms: number): void;
  makeClient?(pairing: Pairing): SyncClient;
  now?(): number;
};

const ACCOUNT_KEY = "connector.accountId";

export class Engine {
  /** One client per connection, kept across ticks: recreating it reset the backoff. */
  private readonly clients = new Map<string, SyncClient>();
  /** When a connection may next be tried. Honoured by every path into `tick`. */
  readonly notBefore = new Map<string, number>();
  /** The one lane every poll goes through: a post is not re-entrant. */
  readonly loop = new Serial();
  private readonly ackBuffer = new Map<string, Ack[]>();
  private readonly errorBuffer = new Map<string, string>();
  /** The batch id in use per connection, keyed by the batch's content, so a retry re-uses it. */
  private readonly batchIds = new Map<string, { key: string; id: string }>();
  private batchSeq = 0;
  /**
   * The service account currently on screen. Persisted the moment it is
   * learned: a worker is evicted between polls and comes back with module
   * state at `null`. Last seen wins; which connection a record is *for* is a
   * separate question answered per pairing by `routing.ts`.
   */
  observedAccountId: string | null = null;
  currentPollMs: number;

  constructor(
    readonly deps: EngineDeps,
    initialPollMs: number,
  ) {
    this.currentPollMs = initialPollMs;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private clientFor(pairing: Pairing): SyncClient {
    let client = this.clients.get(pairing.connectionId);
    // Re-pairing mints a new token, so the cached client would post a dead one.
    if (!client || client.token !== pairing.token) {
      client = this.deps.makeClient ? this.deps.makeClient(pairing) : new SyncClient(pairing);
      this.clients.set(pairing.connectionId, client);
    }
    return client;
  }

  async loadAccountId(): Promise<void> {
    const stored = await this.deps.store.get<string>(ACCOUNT_KEY);
    if (typeof stored === "string" && stored) this.observedAccountId = stored;
  }

  async rememberAccountId(id: string): Promise<void> {
    if (!id || this.observedAccountId === id) return;
    this.observedAccountId = id;
    await this.deps.store.set(ACCOUNT_KEY, id);
  }

  // --- the tap ---------------------------------------------------------------

  async handleTap(observed: Observed): Promise<void> {
    const adapter = this.deps.adapters.find((a) => a.hostPatterns.some((re) => re.test(observed.url)));
    if (!adapter) return;
    const seen = adapter.accountId(observed);
    if (seen) await this.rememberAccountId(seen);
    const records = adapter.parse(observed);
    if (records.length > 0) await this.deps.queue.push(records, seen ?? this.observedAccountId);
  }

  // --- the loop --------------------------------------------------------------

  /**
   * One pass over every pairing. Failures are per pairing, never fatal to the
   * loop. Skipped, not queued, while a pass is already running: a slow pull
   * page must not stack up the ticks that fired during it.
   */
  async tick(): Promise<void> {
    if (this.loop.pending > 0) return;
    await this.loop.run(async () => {
      const pairings = await this.deps.loadPairings();
      for (const pairing of pairings) {
        if ((this.notBefore.get(pairing.connectionId) ?? 0) > this.now()) continue;
        try {
          await this.syncOne(pairing, { pull: true });
        } catch (err) {
          if (err instanceof UnauthorizedError) {
            await this.noteUnauthorized(pairing);
            continue;
          }
          console.error(`[connector] ${pairing.label}:`, err);
        }
      }
      // Records for an account nobody here is paired with would otherwise sit
      // until they aged out as "dropped", which the host shows as data loss.
      await this.deps.queue.discard((r) => orphaned(r, pairings, this.observedAccountId));
    });
  }

  /** A revoked pairing, written where the popup reads. */
  async noteUnauthorized(pairing: Pairing): Promise<void> {
    await this.deps.recordLastPost(pairing.connectionId, {
      at: this.now(),
      ok: false,
      enabled: false,
      accepted: 0,
      duplicates: 0,
      commands: 0,
      pulling: false,
      note: t("pairingRevoked"),
    });
  }

  /**
   * One poll for one pairing: records up, commands and the pull step down.
   * Throws `UnauthorizedError` and nothing else; every other failure is
   * recorded and swallowed, because the loop must go on to the next pairing.
   * `pull: false` skips the pull step; everything else still runs, in
   * particular the commands the host handed out under a lease.
   */
  async syncOne(pairing: Pairing, { pull }: { pull: boolean }): Promise<SyncResponse | null> {
    const adapter = this.deps.adapters.find((a) => a.id === pairing.provider);
    if (!adapter) return null;

    const pairings = await this.deps.loadPairings();
    const batch = await this.deps.queue.peek(MAX_RECORDS_PER_POST, (r) => accepts(pairing, r, pairings, this.observedAccountId));
    const dropped = await this.deps.queue.droppedCount();
    const account = accountFor(pairing, this.observedAccountId);

    const response = await this.exchange(pairing, {
      batchId: this.batchIdFor(pairing.connectionId, batch),
      records: batch.map(toWireRecord),
      externalAccountId: account,
      dropped: dropped || undefined,
      // What will still be waiting *after* this post: the batch riding on it
      // is not "waiting", and counting it made a healthy connection read
      // "1 queued" forever. Always sent, including zero: a drained buffer has
      // to be able to say so.
      queued: Math.max(0, (await this.deps.queue.size()) - batch.length),
    });
    if (!response) return null;

    // Acknowledge by identity, not by count: the tap may have queued more.
    await this.deps.queue.ack(batch);
    this.batchIds.delete(pairing.connectionId);
    if (dropped) await this.deps.queue.clearDropped(dropped);

    await this.handleResponse(pairing, adapter, response, { pull });
    return response;
  }

  /**
   * A batch id stable across retries of the same batch. Minted per peek and
   * re-used while the same records are still waiting, so the host's log can
   * tell a retried post from a new one.
   */
  private batchIdFor(connectionId: string, batch: readonly QueuedRecord[]): string {
    const key = batch.map((r) => `${identity(r)}@${r.queuedAt}`).join("|");
    const current = this.batchIds.get(connectionId);
    if (current && current.key === key) return current.id;
    // A counter as well as the clock: two batches minted in one millisecond
    // must not share an id, or the host's log folds them into one.
    const id = `${connectionId}-${this.now()}-${(this.batchSeq += 1)}`;
    this.batchIds.set(connectionId, { key, id });
    return id;
  }

  /**
   * One post, with the bookkeeping every post needs: the pending error and
   * acks ride along, and come back if nothing reached the host; an ack lost
   * here is a command whose lease expires and which runs **again**.
   */
  private async exchange(pairing: Pairing, payload: Omit<SyncPayload, "error" | "ack">): Promise<SyncResponse | null> {
    const client = this.clientFor(pairing);
    const full: SyncPayload = { ...payload, error: this.drainError(pairing.connectionId), ack: this.drainAcks(pairing.connectionId) };
    const response = await client.post(full);
    if (!response) {
      if (full.error) this.noteError(pairing.connectionId, full.error);
      if (full.ack?.length) this.ackBuffer.set(pairing.connectionId, [...full.ack, ...this.drainAcks(pairing.connectionId)]);
      this.notBefore.set(pairing.connectionId, this.now() + client.backoffMs());
      await this.deps.recordLastPost(pairing.connectionId, {
        at: this.now(),
        ok: false,
        enabled: false,
        accepted: 0,
        duplicates: 0,
        commands: 0,
        pulling: false,
        note: t("hostUnreachable"),
      });
      return null;
    }
    this.notBefore.delete(pairing.connectionId);
    await this.deps.recordLastPost(pairing.connectionId, {
      at: this.now(),
      ok: true,
      enabled: response.enabled,
      accepted: response.accepted,
      duplicates: response.duplicates,
      commands: response.commands.length,
      pulling: response.directives.pull != null,
      note: null,
    });
    return response;
  }

  /**
   * Everything a response is owed, whichever post produced it. The host may
   * claim and hand out commands on **any** post, a progress-only post
   * included, and a response whose commands are dropped burns their lease
   * and an attempt each time, until they fail without ever having run.
   */
  async handleResponse(pairing: Pairing, adapter: ConnectorAdapter, response: SyncResponse, { pull }: { pull: boolean }): Promise<void> {
    // Before anything that needs it: a worker back from eviction with no
    // account id would otherwise fail the whole tick. The host's word is the
    // binding: it routes records to this pairing from now on.
    const account = response.externalAccountId || accountFor(pairing, this.observedAccountId);
    if (response.externalAccountId) await this.deps.bindPairing(pairing.connectionId, response.externalAccountId);

    await this.runCommands(pairing, adapter, response.commands, account);

    if (pull && response.directives.pull) {
      await this.stepPull(pairing, adapter, response.directives.pull, account);
    }

    if (response.directives.pollMs !== this.currentPollMs) {
      this.currentPollMs = response.directives.pollMs;
      this.deps.onPollMs(response.directives.pollMs);
    }
  }

  // --- commands (the reverse direction) ---------------------------------------

  noteError(connectionId: string, message: string): void {
    this.errorBuffer.set(connectionId, message.slice(0, 500));
  }

  /** `null`, never `undefined`, when there is none: the host reads a present `null` as "the fault is over". */
  private drainError(connectionId: string): string | null {
    const message = this.errorBuffer.get(connectionId) ?? null;
    this.errorBuffer.delete(connectionId);
    return message;
  }

  private drainAcks(connectionId: string): Ack[] {
    const acks = this.ackBuffer.get(connectionId) ?? [];
    this.ackBuffer.set(connectionId, []);
    return acks;
  }

  /**
   * Results are buffered and reported on the **next** post, so a create and
   * its acknowledgement are two round trips and a browser closing between
   * them lets the lease expire: the command comes back rather than being lost.
   * Appended one at a time, so a worker evicted mid-list keeps the acks for
   * the commands it did finish.
   */
  private async runCommands(pairing: Pairing, adapter: ConnectorAdapter, commands: Command[], account: string | null): Promise<void> {
    for (const command of commands) {
      const ack = await this.runCommand(command, adapter, account);
      if (ack) this.ackBuffer.set(pairing.connectionId, [...(this.ackBuffer.get(pairing.connectionId) ?? []), ack]);
    }
  }

  /**
   * One command. `null` means "a kind this build does not know": left
   * unacknowledged on purpose, so the lease expires and a newer build gets to
   * try, rather than this one reporting a permanent failure on its behalf.
   */
  private async runCommand(command: Command, adapter: ConnectorAdapter, account: string | null): Promise<Ack | null> {
    // Every action is addressed to a specific account. Without one we do not
    // know whose data we would be touching, so nothing is attempted.
    if (!account) return { id: command.id, ok: false, error: t("accountUnknown") };
    if (!adapter.execute) return null;
    try {
      return await adapter.execute(command, this.deps.http, account);
    } catch (err) {
      return { id: command.id, ok: false, error: err instanceof Error ? err.message.slice(0, 500) : String(err) };
    }
  }

  // --- the pull step -----------------------------------------------------------

  /**
   * One page of a host-directed pull, then a post carrying the progress. A
   * failed page is not a failed pull: the cursor on the host has not moved, so
   * the next tick retries exactly where this one stopped. But it is reported,
   * so the host can say which of "tab closed", "account unknown" or an HTTP
   * error is holding the bar at zero.
   */
  private async stepPull(pairing: Pairing, adapter: ConnectorAdapter, directive: { kind: string; cursor: unknown; pageSize: number }, account: string | null): Promise<void> {
    try {
      if (!account) throw new Error(t("accountUnknown"));
      if (!adapter.pull) throw new Error(t("unknownCommand"));
      const page = await adapter.pull(directive.kind, directive.cursor, directive.pageSize, this.deps.http, account);
      if (page.records.length > 0) await this.deps.queue.push(page.records, account);
      if (page.warning) this.noteError(pairing.connectionId, `${t("pullPaused")}: ${page.warning}`);
      if (page.error) this.noteError(pairing.connectionId, `${t("pullPaused")}: ${page.error}`);

      const response = await this.exchange(pairing, {
        batchId: `${pairing.connectionId}-pull-${this.now()}`,
        records: [],
        externalAccountId: account,
        pull: { kind: directive.kind, cursor: page.cursor, done: page.done, total: page.total ?? null, finished: page.cursor === null, skipped: page.skipped },
      });
      // The page's records are safe in the buffer either way; only the cursor
      // failed to move, and the next tick re-reads the same page, which the
      // buffer and the host both de-duplicate.
      if (!response) throw new Error(t("pullProgressNotSaved"));
      // The progress post is a post like any other: whatever it was handed
      // must be run. `pull: false`: this tick has done its page.
      await this.handleResponse(pairing, adapter, response, { pull: false });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.noteError(pairing.connectionId, `${t("pullPaused")}: ${reason}`);
    }
  }
}

/**
 * The wire shape of a queued record, listed field by field rather than
 * spread, so `queuedAt` and `accountId` (buffer bookkeeping) cannot ride
 * along, and anything added to the buffer later has to be added on purpose.
 */
function toWireRecord(record: QueuedRecord): ConnectorRecord {
  return {
    kind: record.kind,
    externalId: record.externalId,
    externalUpdatedAt: record.externalUpdatedAt,
    payload: record.payload,
    raw: record.raw,
  };
}
```

## Decisions worth not relitigating

**Every response is handled the same way.** The host may claim and hand out
commands on *any* post, including the progress-only post the pull step makes.
The earlier implementation discarded that response; a command that became
due between the two posts was leased and had its attempt counter
incremented without running, and after enough misses was marked failed having
never executed. `exchange()` + `handleResponse()` is the fix, and
`engine.test.ts` pins it.

**Acks ride the next post, never the same one.** A create and its
acknowledgement are two round trips, so a browser closing between them lets
the lease expire and the command comes back rather than being lost. Acks are
appended one at a time so a worker evicted mid-list keeps the ones it finished.

**One client per connection, cached.** `SyncClient` counts consecutive
failures to grow its backoff. Constructing a fresh one each tick reset the
counter every pass, so the backoff never escalated and every install hammered
a failing host every 30 s for the length of an outage.

**`notBefore` is a timestamp, honoured by every path into `tick`.** The
backoff used to be applied by stretching the `setInterval`, which the alarm
ignored. A human pressing "test" is the one exception and clears it.

**`error` is sent as `null`, not omitted, once reported.** The host reads a
present `null` as "the fault is over, clear the card" and an absent field as
"no opinion". A recovered install has to be able to say so.

**`queued` excludes the batch in flight.** Counting it made a healthy
connection read "1 queued" on every card, forever.

**Batch ids are stable across retries and unique within a millisecond.** A
clock alone collides when two batches are minted in one tick; the sequence
number is not decoration.

## Checklist

- [ ] `handleResponse` called for every non-null response, including the progress post
- [ ] Acks buffered, drained on the next post, restored on a failed post
- [ ] `SyncClient` cached per connection and replaced only on a token change
- [ ] `notBefore` checked in `tick`, cleared by `diagnose`
- [ ] Unknown command kinds return `null`, not a failed ack
