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
