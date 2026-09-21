# Diagnostics

The "Test connection" button: answer "why is nothing syncing?" without anyone
opening a service-worker console.

## It runs a real poll

The question is whether the channel works *now*. Replaying the last known
outcome would report health for a connection that broke an hour ago. So the
screen runs the ordinary poll through the engine's lane, minus the pull step,
so it answers in seconds, and because it is the ordinary poll, the commands
the host hands it are **run**. An earlier version posted an empty batch,
received the leased commands and dropped them, so every press of the button
delayed a pending pull by one lease. A human pressing the button also clears
the connection's backoff: they are owed an answer now.

## src/background/diagnostics.ts

```ts
// extension/src/background/diagnostics.ts
import type { SyncResponse } from "../wire";
import type { Diagnosis, DiagnosisCheck } from "../shared/messages";
import { t } from "../shared/strings";
import { UnauthorizedError } from "./client";
import type { Engine } from "./engine";

/**
 * Answer "why is nothing syncing?" without anyone opening a worker console.
 *
 * Runs a **real** poll through the engine's lane: the question is whether
 * the channel works *now*, and replaying the last known outcome would report
 * health for a connection that broke an hour ago. It is the ordinary poll
 * minus the pull step, so it answers in seconds; and because it is the
 * ordinary poll, the commands it is handed are run rather than delayed by a
 * lease. Checks are ordered the way the pipeline is: the first failure is the
 * thing to fix.
 */
export async function diagnose(engine: Engine, connectionId: string): Promise<Diagnosis> {
  const { deps } = engine;
  const checks: DiagnosisCheck[] = [];
  const pairing = (await deps.loadPairings()).find((p) => p.connectionId === connectionId);
  const adapter = pairing ? deps.adapters.find((a) => a.id === pairing.provider) : undefined;
  const writeSupported = adapter?.writeVerified ?? false;

  if (!pairing) {
    checks.push({ id: "pairing", label: t("checkPairing"), state: "fail", detail: t("notPairedHere") });
    return { checks, up: { queued: 0, dropped: 0, acceptedLastPost: 0, duplicatesLastPost: 0, lastPostAt: null }, down: { commandsLastPost: 0, writeSupported } };
  }
  const origin = new URL(pairing.syncUrl).origin;
  checks.push({ id: "pairing", label: t("checkPairing"), state: "ok", detail: `"${pairing.label}" to ${origin}` });

  // 1. Does the host answer, and does it still accept this token? A human is
  // asking, so a backoff in progress does not apply.
  engine.notBefore.delete(connectionId);
  let response: SyncResponse | null = null;
  let unauthorized = false;
  try {
    response = await engine.loop.run(() => engine.syncOne(pairing, { pull: false }));
  } catch (err) {
    unauthorized = err instanceof UnauthorizedError;
    if (!unauthorized) throw err;
    await engine.noteUnauthorized(pairing);
  }

  if (unauthorized) {
    checks.push({ id: "host", label: t("checkHost"), state: "fail", detail: t("pairingRevoked") });
  } else if (!response) {
    checks.push({ id: "host", label: t("checkHost"), state: "fail", detail: t("hostNoAnswer", { origin }) });
  } else {
    checks.push({ id: "host", label: t("checkHost"), state: "ok", detail: t("hostOk") });
    // 2. The single most common cause of "paired but nothing happens".
    checks.push(
      response.enabled
        ? { id: "enabled", label: t("checkEnabled"), state: "ok", detail: t("enabledOk") }
        : { id: "enabled", label: t("checkEnabled"), state: "fail", detail: t("enabledOff") },
    );
  }

  // 3. Is a service tab open, and has the page authenticated in it?
  const relay = await deps.relayStatus();
  if (!relay) {
    checks.push({ id: "tab", label: t("checkServiceTab"), state: "warn", detail: t("serviceTabMissing") });
  } else {
    checks.push({ id: "tab", label: t("checkServiceTab"), state: "ok", detail: relay.pageUrl });
    checks.push(
      relay.authenticated
        ? { id: "auth", label: t("checkSession"), state: "ok", detail: t("sessionOk", { origin: relay.authOrigin ?? "" }) }
        : { id: "auth", label: t("checkSession"), state: "fail", detail: t("sessionMissing") },
    );
  }

  // 4. Do we know whose account this is? Everything write-side needs it. The
  // binding is re-read: the poll above may have just learned it.
  const bound = (await deps.loadPairings()).find((p) => p.connectionId === connectionId)?.accountId ?? null;
  const observed = engine.observedAccountId;
  const account = bound ?? observed;
  const mismatch = bound && observed && bound !== observed;
  checks.push(
    !account
      ? { id: "account", label: t("checkAccount"), state: "fail", detail: t("accountMissing") }
      : mismatch
        ? { id: "account", label: t("checkAccount"), state: "warn", detail: t("accountMismatch", { bound, observed: observed ?? "" }) }
        : { id: "account", label: t("checkAccount"), state: "ok", detail: t("accountOk", { account }) },
  );

  const queued = await deps.queue.size();
  const dropped = await deps.queue.droppedCount();
  checks.push(
    dropped > 0
      ? { id: "buffer", label: t("checkBuffer"), state: "warn", detail: t("bufferDropped", { queued, dropped }) }
      : { id: "buffer", label: t("checkBuffer"), state: "ok", detail: t("bufferOk", { queued }) },
  );

  // 5. The downward channel, stated rather than implied by silence. `info`,
  // not `warn`: a product-wide fact, not a fault with this install.
  checks.push(
    writeSupported
      ? { id: "write", label: t("checkWrite"), state: "ok", detail: t("writeOn") }
      : { id: "write", label: t("checkWrite"), state: "info", detail: t("writeOff") },
  );

  const last = (await deps.loadLastPosts())[connectionId] ?? null;
  return {
    checks,
    up: {
      queued,
      dropped,
      acceptedLastPost: last?.accepted ?? 0,
      duplicatesLastPost: last?.duplicates ?? 0,
      lastPostAt: response ? Date.now() : last?.ok ? last.at : null,
    },
    down: { commandsLastPost: last?.commands ?? 0, writeSupported },
  };
}
```

## The ladder

Checks are ordered the way the pipeline is; the first failure is the thing to
fix.

| # | Check | fail means | warn means | info means |
|---|---|---|---|---|
| 0 | Pairing | not paired in this browser | | |
| 1 | Host app | no answer, or 401 (revoked) | | |
| 2 | Connection enabled | paused in the host: the single most common "paired but nothing happens" | | |
| 3 | Service tab | | no tab open: observation works, pulls and commands do not | |
| 4 | Service session | tab open, no authenticated request seen: the tap is dead, or nobody is signed in | | |
| 5 | Recognised account | none seen yet | bound to one account, tab shows another | |
| 6 | Offline buffer | | records dropped since last report | |
| 7 | Writes | | | product-wide: adapter's write path unverified |

Two states that are not faults and must not read as such: `info` never sets
the summary (while it did, every healthy install summarised as "working with
caveats" and the one word meant to answer "is it working?" never said yes);
and a fresh pairing whose first pull has not landed is "in progress", not a
warning, because flagging it tells every new user their install has a problem
on the day they set it up.

## The two directions, separately

The report splits "up" (records to the host) from "down" (commands to the
service) because they fail independently: records can flow perfectly while
the command path is dead, and one combined "synced" indicator would be a lie
half the time. The down box says outright when writing is switched off, a state
somebody would otherwise discover by waiting.

The numbers under "up" are the poll's own: what it carried and what the host
handed down. Label them "last post", not "this test": the test posts the
buffer as it stands, and calling its zeros "the result of the test" invites
the reading that the test moved nothing.

## Checklist

- [ ] Runs `syncOne(pairing, { pull: false })` through the lane
- [ ] Clears `notBefore` first
- [ ] Pipeline order; `info` excluded from the summary
- [ ] Never reports a credential, only presence and origin
