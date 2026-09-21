# The server contract

What the host app must implement for this extension to work. Shapes are shown
as the types the extension imports; the host owns the authoritative copy and
its validator. Route and schema templates are out of this skill's scope — the
host builds them in its own idiom.

## src/wire.ts (shared types)

```ts
/**
 * The contract between the extension and the host app.
 *
 * The host owns the authoritative copy (with its validator — see
 * `server-contract.md`); the extension imports these as **types only**, so no
 * validation library ever reaches the service worker. Two copies drift silently
 * — a renamed field simply stops arriving — so keep this file byte-identical on
 * both sides, or have the host publish it and import from there.
 *
 * Nothing here names a service. The extension normalises; the host stays
 * service-agnostic. A service changing how it serves data is an extension
 * release, not a host deploy.
 */

/** A record kind is whatever the host defines; the runtime treats it as a string. */
export type ConnectorRecord<K extends string = string> = {
  kind: K;
  /** The service's own id for this thing — numeric, slug, anything. ≤128 chars. */
  externalId: string;
  /** The service's change marker, when it exposes one. Ordering only, never identity. */
  externalUpdatedAt?: string | null;
  /** Normalised by the adapter to the host's per-kind schema. */
  payload: unknown;
  /** As captured. Never parsed by the host; stored so a parser fix can re-process. */
  raw?: unknown;
};

/**
 * Batch size cap. A browser offline over a weekend must not be able to post one
 * request the host cannot finish — it pages instead, and the buffer makes that free.
 */
export const MAX_RECORDS_PER_BATCH = 200;

/** What the extension posts. */
export type SyncRequest = {
  token: string;
  agentVersion?: string;
  /** Stable for one batch across retries, so a re-post is recognisable in the host's log. */
  batchId: string;
  /** Validated **record by record** by the host — see `server-contract.md`. */
  records: ConnectorRecord[];
  /** The account the service showed the extension, learned from the page. */
  externalAccountId?: string | null;
  /** Buffered records the extension had to drop since the last post. */
  dropped?: number;
  /** Buffered records still waiting *after* this post. */
  queued?: number;
  /** Progress of a host-directed pull, when one ran this tick. */
  pull?: {
    kind: string;
    cursor: unknown;
    done?: number;
    total?: number | null;
    finished?: boolean;
    skipped?: number;
  };
  /**
   * Why the last attempt failed, in the extension's own words, or `null` when it
   * did not. Always sent: a present `null` means "the fault is over", an absent
   * field means "no opinion". Never a credential; capped at 500 chars.
   */
  error?: string | null;
  /** Results of the commands handed out on a previous poll. ≤50. */
  ack?: Ack[];
};

export type Ack = {
  id: string;
  ok: boolean;
  /** The id the service assigned — the only key a later delete may address. */
  externalRef?: string | null;
  error?: string | null;
};

export type RejectedRecord = { externalId: string; reason: string };

/** A unit of work the host wants done in the service. Kinds are host-defined. */
export type Command = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  /** For deletes: the service's id for the thing we created earlier. */
  externalRef: string | null;
};

/** What the host answers. Every response may carry commands — run them all. */
export type SyncResponse = {
  accepted: number;
  duplicates: number;
  rejected: RejectedRecord[];
  /** Handed back on every poll: the worker cannot keep it across an eviction. */
  externalAccountId: string | null;
  /** A paused connection is answered normally so it can still say "paused", not "offline". */
  enabled: boolean;
  commands: Command[];
  directives: {
    /** Milliseconds until the next poll — the host paces the client. */
    pollMs: number;
    /** Present while the host wants a pull to continue; absent or null means stop. */
    pull?: { kind: string; cursor: unknown; pageSize: number } | null;
  };
  serverTime: string;
};

export type PairRequest = { pin: string; connectionId?: string };

export type PairResponse =
  | { tenantName: string; connections: { id: string; label: string; paired: boolean }[] }
  | { token: string; connectionId: string; syncUrl: string };
```

## `POST <host>/api/connector/pair`

Two steps through one endpoint, mirroring the two views of the pairing screen.

| Body | Answer | Notes |
|---|---|---|
| `{ pin }` | `200 { tenantName, connections: [{ id, label, paired }] }` | lists; **issues nothing** |
| `{ pin, connectionId }` | `200 { token, connectionId, syncUrl }` | mints the token; `syncUrl` **absolute**, built from the request URL, so the extension talks back to the host it paired against rather than a base someone typed |
| wrong PIN, or tenant has no PIN | `401` with one identical message | neither case may tell a caller which it hit |
| unknown connection | `404` | |
| too many attempts | `429` | rate-limit per IP; a 6-digit PIN falls in minutes otherwise. Note: an in-memory limiter on serverless resets per instance — use a shared store if the host is serverless |

Requirements: the tenant is derived from the **request host** (or the session),
never from the body — an extension that could name its own tenant could pair
itself into somebody else's. The PIN is compared in constant time. The token is
32 random bytes, base64url; the host stores only `sha256(pepper ‖ token)` in a
table nobody but the server can read, keyed by connection; revocation is one
row delete. Rotating the PIN does not disconnect paired browsers; "disconnect"
does. Re-pairing a connection invalidates its previous token.

## `POST <syncUrl>` — the one sustaining request

Body: `SyncRequest`. Answer: `SyncResponse`. Order inside the handler is
load-bearing:

1. **Parse the envelope**; refuse a malformed envelope with 400.
2. **Validate records one by one.** Validating `records` as part of the
   envelope means one malformed row fails the whole request; the extension
   reads any non-2xx as "not taken", keeps every record and re-posts the same
   batch every tick — so one bad row stops **all** sync, of every kind,
   indefinitely, while the empty diagnostics poll still validates and the
   card says "connected". Name each refusal in `rejected`; the extension
   acknowledges rejected records exactly like accepted ones, which is what
   finally drops them from the buffer.
3. **Resolve the token** → one connection. Unknown → `401` (revoked, deleted,
   never paired alike).
4. **Paused connection** → `200` with `enabled: false`, empty `commands`,
   `pollMs` around 60 000. Answered, not refused: the install must keep
   checking in so the host can say "paused" rather than "offline", and so
   re-enabling takes effect without anyone touching the browser.
5. **Heartbeat before any work that can fail**, so a failing batch still
   proves the browser is alive. Store `agentVersion`, `queued`, `dropped`
   (increment atomically — two posts from one browser would otherwise
   overwrite each other), `externalAccountId` (bind on first sight), and
   `error` — `null` clears the stored fault, absent leaves it.
6. **Apply acks** from the previous poll: `ok` → done with `externalRef`
   stored (the only key a later delete may use); not ok → retry with backoff,
   fail past the attempt cap and make it visible.
7. **Stage the records** in a staging table with a unique key
   `(connection, kind, externalId, contentHash)`, where the hash is computed
   **by the host over the normalised payload** — never by the client (a stale
   build declaring two payloads identical would drop a real change), and not
   over `raw` (a service reordering JSON keys must not re-apply an archive).
   A conflict is a `duplicate`, counted and surfaced so "nothing changed" is
   visible. If staging itself refuses a row the schema passed (a NUL byte in
   `jsonb`, say), sanitise before hashing and retry the batch row by row so
   one poisonous record costs one record — and write the refusal where the
   card shows faults, because from the extension's side that post succeeded.
8. **Update pull progress** if `pull` is present; a `finished` pull must not
   be handed one more page off a stale snapshot.
9. **Claim commands** under a lease (`for update skip locked`, lease ~2 min,
   attempt counter, cap). Exactly one browser gets a command; a browser that
   dies mid-command lets the lease expire and the command returns to the pool.
   **Every response may carry commands**, and the extension runs them from
   every response — including its progress-only post.
10. **Return** `SyncResponse`, with `Cache-Control: private, no-store`. Apply
    the staged rows **off the request** (after-response hook, then a cron for
    whatever is left). A crash mid-apply loses nothing; the row is still
    pending.

## Directives and pacing

| Field | Meaning |
|---|---|
| `pollMs` | next poll in ms; e.g. 30 000 idle, 5 000 while a pull is wanted, 60 000 paused |
| `pull` | `{ kind, cursor, pageSize }` while the host wants a pull to continue; absent or `null` means stop. The cursor belongs to the **host**: a tab closing mid-pull costs one page, not the run |
| `externalAccountId` | echoed on every response — the worker cannot keep it across eviction |
| `commands[].payload` | rendered server-side where every install must write the identical thing (a marker title, say), so changing it is one deploy, not a wait for every browser to update |

## Health

Derive it on read from `last_seen_at`; store nothing. A stored status needs a
cron to move it to "stale", and a cron that quietly stops makes every
connection look healthy — the exact failure the display exists to catch. A
paused connection reads "paused", never "offline". Because this module's
failure mode is *absence*, push an alert when an enabled connection goes quiet,
debounced to once a day.

## Retention and undo

Keep `raw` for a bounded period (30 days worked) so a parser bug can be
re-processed from what is already held instead of asking the user to walk
their history again. Provide a way back: delete what the sync created, keep
what the user built or built upon — mark rows created by sync at creation time
and check named dependencies before deleting, with reasons reported.

## Reference validator shape

One way to write step 2, for a host using zod. Illustrative, not part of the
verified templates:

```ts
const envelope = z.object({
  token: z.string().min(1).max(200),
  agentVersion: z.string().max(32).optional(),
  batchId: z.string().min(1).max(64),
  records: z.array(z.unknown()).max(MAX_RECORDS_PER_BATCH).default([]), // opaque here, on purpose
  externalAccountId: z.string().min(1).max(128).nullish(),
  dropped: z.number().int().min(0).optional(),
  queued: z.number().int().min(0).optional(),
  pull: z.object({ kind: z.string(), cursor: z.unknown(), done: z.number().int().optional(),
    total: z.number().int().nullish(), finished: z.boolean().optional(), skipped: z.number().int().optional() }).optional(),
  error: z.string().max(500).nullish(),
  ack: z.array(z.object({ id: z.string(), ok: z.boolean(), externalRef: z.string().nullish(), error: z.string().max(500).nullish() })).max(50).default([]),
});

function parseRecords(raw: readonly unknown[]) {
  const records = [], rejected = [];
  for (const value of raw) {
    const parsed = recordSchema.safeParse(value); // your discriminated union over kinds
    if (parsed.success) records.push(parsed.data);
    else rejected.push({ externalId: idOf(value), reason: firstIssue(parsed.error) }); // one short line, not a tree
  }
  return { records, rejected };
}
```

## Checklist

- [ ] Tenant from host/session, never from the body
- [ ] Records validated individually; `rejected` populated
- [ ] Heartbeat before staging; `error: null` clears
- [ ] Content hash computed server-side over the normalised payload
- [ ] Commands leased with attempt cap; acks with `externalRef` stored
- [ ] Paused answered with 200; unknown token 401
- [ ] Health derived, silence alerted
