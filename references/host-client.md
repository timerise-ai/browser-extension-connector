# The host client and stored pairings

How the worker talks to the host app, and what it remembers about where it is
paired.

## src/background/client.ts

```ts
import type { SyncRequest, SyncResponse } from "../wire";
import type { Pairing } from "./config";

/**
 * The HTTP client for the host app. One request type; `server-contract.md`
 * is the other end.
 *
 * Carries its own backoff rather than leaning on the host's `pollMs`: a host
 * that is down cannot tell us to slow down, and every install hammering a
 * failing deploy every 30 s is how a small outage becomes a large one.
 */

/** Everything but `token` and `agentVersion`, which the client adds. */
export type SyncPayload = Omit<SyncRequest, "token" | "agentVersion">;

export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";
}

/**
 * How long one post may take before it is given up on. Without a ceiling a
 * request that never completes — a proxy that swallows the connection, a
 * laptop that slept mid-POST — held the loop's in-flight guard until Chrome
 * happened to evict the worker.
 */
const REQUEST_TIMEOUT_MS = 25_000;

export class SyncClient {
  private failures = 0;

  constructor(private readonly pairing: Pairing) {}

  /** Read by the loop to notice a re-pairing: a cached client would keep posting a revoked token. */
  get token(): string {
    return this.pairing.token;
  }

  /** Milliseconds to wait after a failure. Capped, so recovery is never longer than a coffee. */
  backoffMs(): number {
    return this.failures === 0 ? 0 : Math.min(5 * 60_000, 2 ** Math.min(this.failures, 6) * 1_000);
  }

  async post(payload: SyncPayload): Promise<SyncResponse | null> {
    try {
      const res = await fetch(this.pairing.syncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No cookies to the host: the token is the credential, and sending
        // ambient credentials to a host the user typed would leak a session
        // into a third party if that host were wrong.
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ token: this.pairing.token, agentVersion: __AGENT_VERSION__, ...payload }),
      });

      if (res.status === 401) {
        // Revoked, unpaired, or the host rotated its pepper. Stop; the options
        // page is where a human re-pairs. Retrying a 401 forever is how an
        // extension ends up in a log nobody reads.
        this.failures = 0;
        throw new UnauthorizedError();
      }
      if (!res.ok) {
        this.failures += 1;
        return null;
      }
      const body = asSyncResponse(await res.json());
      if (!body) {
        // A 200 that is not ours: a captive portal, a CDN error page with the
        // wrong status, a proxy answering for a dead deploy.
        this.failures += 1;
        return null;
      }
      this.failures = 0;
      return body;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      this.failures += 1;
      return null;
    }
  }
}

/**
 * The response, if it has the shape the loop is about to read from it. Only
 * the fields the loop dereferences without a guard are checked; the rest are
 * defaulted so a host one field ahead of this build still parses.
 */
export function asSyncResponse(value: unknown): SyncResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const directives = v.directives;
  if (typeof directives !== "object" || directives === null) return null;
  const d = directives as Record<string, unknown>;
  const pollMs = d.pollMs;
  if (typeof pollMs !== "number" || !Number.isFinite(pollMs) || pollMs < 1_000) return null;
  if (typeof v.enabled !== "boolean") return null;
  const pull = d.pull;
  return {
    accepted: typeof v.accepted === "number" ? v.accepted : 0,
    duplicates: typeof v.duplicates === "number" ? v.duplicates : 0,
    rejected: Array.isArray(v.rejected) ? (v.rejected as SyncResponse["rejected"]) : [],
    externalAccountId: typeof v.externalAccountId === "string" ? v.externalAccountId : null,
    enabled: v.enabled,
    commands: Array.isArray(v.commands) ? (v.commands as SyncResponse["commands"]) : [],
    directives: {
      pollMs,
      pull: typeof pull === "object" && pull !== null ? (pull as NonNullable<SyncResponse["directives"]["pull"]>) : null,
    },
    serverTime: typeof v.serverTime === "string" ? v.serverTime : "",
  };
}
```

## The four failure classes

| Host answers | Client does | Why |
|---|---|---|
| 401 | throws `UnauthorizedError`, resets failures | revoked, unpaired, or the host rotated its pepper; the options page is where a human re-pairs, and retrying forever fills a log nobody reads |
| other non-2xx | returns `null`, failures + 1 | the batch was not taken; records stay buffered |
| 200 with a foreign body | returns `null`, failures + 1 | a captive portal, a CDN error page with the wrong status, a proxy answering for a dead deploy; reading `commands.length` off it used to throw out of the loop |
| nothing within 25 s | returns `null`, failures + 1 | a request that never completes held the loop's in-flight guard until Chrome happened to evict the worker |

Backoff is `2^n` seconds capped at five minutes, reset on the first success.
It is the client's, not the host's: a host that is down cannot ask anyone to
slow down, and every install hammering a failing deploy every 30 s is how a
small outage becomes a large one.

`asSyncResponse` checks only the fields the loop dereferences without a guard
and defaults the rest, so a host one field ahead of this build still parses.

`credentials: "omit"` to the host is deliberate: the token is the credential,
and sending ambient cookies to a host the user typed would leak a session into
a third party if that host were wrong.

## src/background/config.ts

```ts
/**
 * What the extension knows about where it is paired. Lives in
 * `chrome.storage.local`, which is per profile and per install — exactly the
 * scope a pairing has.
 *
 * A list, not a single record: one browser may carry several connections (two
 * accounts on one service, or two services). Everything downstream loops over it.
 */

export type Pairing = {
  /** Absolute, from the pair response — the extension never composes it. */
  syncUrl: string;
  token: string;
  connectionId: string;
  /** Adapter id, so the right parser handles the right host. */
  provider: string;
  label: string;
  pairedAt: number;
  /**
   * The service account this connection is bound to, as the host knows it.
   * Learned from `SyncResponse.externalAccountId` and kept here so a worker
   * that wakes from eviction knows which account to pull and write into
   * without waiting for a poll, and so a browser paired twice routes each
   * account's records to its own connection (`routing.ts`). Absent until the
   * host has bound it; a fresh pairing starts unbound on purpose, which is
   * also how a wrongly bound connection is re-bound: pair again while the
   * service shows the right account.
   */
  accountId?: string | null;
};

const KEY = "connector.pairings";

export async function loadPairings(): Promise<Pairing[]> {
  const bag = await chrome.storage.local.get(KEY);
  const list = bag[KEY];
  return Array.isArray(list) ? (list as Pairing[]) : [];
}

export async function savePairing(pairing: Pairing): Promise<void> {
  const existing = await loadPairings();
  // Re-pairing the same connection replaces its token rather than adding a
  // second entry — otherwise a re-paired browser posts twice per poll with one
  // dead credential, and the host shows an error that fixes itself and returns.
  const next = [...existing.filter((p) => p.connectionId !== pairing.connectionId), pairing];
  await chrome.storage.local.set({ [KEY]: next });
}

export async function removePairing(connectionId: string): Promise<void> {
  const next = (await loadPairings()).filter((p) => p.connectionId !== connectionId);
  await chrome.storage.local.set({ [KEY]: next });
}

/** Record the account the host bound a pairing to. No-op if already so. */
export async function bindPairing(connectionId: string, accountId: string): Promise<void> {
  const existing = await loadPairings();
  const current = existing.find((p) => p.connectionId === connectionId);
  if (!current || current.accountId === accountId) return;
  const next = existing.map((p) => (p.connectionId === connectionId ? { ...p, accountId } : p));
  await chrome.storage.local.set({ [KEY]: next });
}

/**
 * The outcome of the most recent post, per connection.
 *
 * In storage rather than in the worker, for two reasons. The popup and the
 * options page read it, and neither may import the worker module — it installs
 * listeners and starts a timer at import time, so reading a number out of it
 * would boot a second copy of the extension inside the page asking. And the
 * worker is evicted between polls, so anything held in memory is gone by the
 * time somebody opens a window to look — and an empty screen reads as
 * "nothing has ever happened" rather than "I forgot".
 */
export type LastPost = {
  at: number;
  ok: boolean;
  enabled: boolean;
  accepted: number;
  duplicates: number;
  commands: number;
  /** A host-directed pull was in progress as of that post. */
  pulling: boolean;
  /** Why it failed, when it did. Never a credential. */
  note: string | null;
};

const LAST_POST_KEY = "connector.lastPost";

export async function loadLastPosts(): Promise<Record<string, LastPost>> {
  const bag = await chrome.storage.local.get(LAST_POST_KEY);
  const map = bag[LAST_POST_KEY];
  return map && typeof map === "object" ? (map as Record<string, LastPost>) : {};
}

export async function recordLastPost(connectionId: string, outcome: LastPost): Promise<void> {
  const all = await loadLastPosts();
  await chrome.storage.local.set({ [LAST_POST_KEY]: { ...all, [connectionId]: outcome } });
}
```

Two rules the two UIs depend on:

- **Neither the popup nor the options page imports the worker module.** It
  installs listeners and starts a timer at import time; importing it to read a
  number would boot a second copy of the extension inside the page asking.
  They read storage.
- **`LastPost` is in storage, not memory**, because the worker is evicted
  between polls and an empty popup reads as "nothing has ever happened".

`savePairing` replaces an entry with the same `connectionId` rather than
appending: a re-paired browser would otherwise post twice per poll with one
dead token, and the host would show an error that fixes itself and returns.

## Checklist

- [ ] One `SyncClient` per connection, replaced only when the token changes ([sync-engine.md](sync-engine.md))
- [ ] `AbortSignal.timeout` on every post
- [ ] 401 handled before `res.ok`
- [ ] UI pages import from `config.ts`, never from `index.ts`
