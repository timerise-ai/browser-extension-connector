/**
 * The contract between the extension and the host app.
 *
 * The host owns the authoritative copy (with its validator, see
 * `server-contract.md`); the extension imports these as **types only**, so no
 * validation library ever reaches the service worker. Two copies drift
 * silently, because a renamed field simply stops arriving, so keep this file
 * byte-identical on both sides, or have the host publish it and import from there.
 *
 * Nothing here names a service. The extension normalises; the host stays
 * service-agnostic. A service changing how it serves data is an extension
 * release, not a host deploy.
 */

/** A record kind is whatever the host defines; the runtime treats it as a string. */
export type ConnectorRecord<K extends string = string> = {
  kind: K;
  /** The service's own id for this thing: numeric, slug or anything, 128 characters at most. */
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
 * request the host cannot finish: it pages instead, and the buffer makes that free.
 */
export const MAX_RECORDS_PER_BATCH = 200;

/** What the extension posts. */
export type SyncRequest = {
  token: string;
  agentVersion?: string;
  /** Stable for one batch across retries, so a re-post is recognisable in the host's log. */
  batchId: string;
  /** Validated **record by record** by the host, see `server-contract.md`. */
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
  /** Results of the commands handed out on a previous poll, 50 at most. */
  ack?: Ack[];
};

export type Ack = {
  id: string;
  ok: boolean;
  /** The id the service assigned: the only key a later delete may address. */
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

/** What the host answers. Every response may carry commands: run them all. */
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
    /** Milliseconds until the next poll: the host paces the client. */
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
