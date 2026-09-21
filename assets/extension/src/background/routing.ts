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
