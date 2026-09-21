# The relay

The isolated-world content script: the only bridge between the page and the
extension. Three jobs and deliberately no logic beyond them — anything smarter
belongs in the worker, which is testable and survives a navigation.

## src/content/relay.ts

```ts
/**
 * Isolated-world relay: the only bridge between the page and the extension.
 *
 * Three jobs, and deliberately no logic beyond them — anything smarter belongs
 * in the service worker, which is testable and survives a navigation.
 *
 *  1. Forward tapped responses from the MAIN world to the worker.
 *  2. Hold a long-lived port to the worker and **ping it**. An MV3 worker is
 *     evicted ~30 s after its last event and a merely-open port is not an
 *     event; traffic on it is. This is what lets the loop run at the host's
 *     cadence while a service tab is open.
 *  3. Perform the requests the worker needs made against the service — pulls
 *     and commands — authenticated exactly as the page authenticates itself.
 *
 * The rules that keep a live credential in memory defensible: read only from
 * requests the page itself made; replayed only to the origin it was captured
 * from, checked on every call; never persisted; never sent to the host.
 */

import type {
  RelayFetchRequest,
  RelayFetchResult,
  RelayPing,
  RelayStatusRequest,
  RelayStatusResult,
} from "../shared/messages";
import { isContextInvalidated } from "../shared/context";
import { t } from "../shared/strings";

/** Mirrors of the two channel names in `inject/net-tap.ts`. Change one, change both. */
const TAP_MESSAGE = "connector-tap";
const AUTH_MESSAGE = "connector-auth";
/** Mirrors `background/constants.ts` — imported here would be fine, but kept literal for symmetry with the tap. */
const PORT_NAME = "connector-keepalive";

let port: chrome.runtime.Port | null = null;

/** Captured from the page's own traffic. In memory only, never stored. */
let auth: { origin: string; headers: Record<string, string> } | null = null;

/**
 * Has the extension been reloaded out from under this script? Terminal, not
 * retryable: only loading the page again injects fresh scripts. Pointing the
 * reconnect below at an invalidated context turned one reload into an
 * uncaught error every second, forever, in every open tab.
 */
let orphaned = false;

/** Twenty seconds leaves a margin for a busy page delaying the timer. */
const KEEPALIVE_MS = 20_000;
let keepalive: ReturnType<typeof setInterval> | null = null;

function connect(): void {
  if (orphaned) return;
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch (err) {
    port = null;
    if (isContextInvalidated(err)) orphaned = true;
    else setTimeout(connect, 1_000);
    return;
  }
  if (keepalive) clearInterval(keepalive);
  keepalive = setInterval(() => post({ type: "relay-ping" } satisfies RelayPing), KEEPALIVE_MS);

  // A disconnect means the worker was replaced (an update, a crash). Reconnect
  // rather than going quiet — quiet looks exactly like healthy with no data.
  port.onDisconnect.addListener(() => {
    port = null;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    setTimeout(connect, 1_000);
  });
  port.onMessage.addListener(async (msg: RelayFetchRequest | RelayStatusRequest) => {
    if (msg?.type === "relay-status") {
      post(describeSelf(msg.id));
      return;
    }
    if (msg?.type !== "relay-fetch") return;
    post(await performFetch(msg));
  });
}

/** Reply down the port, tolerating its disappearance mid-request. */
function post(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch (err) {
    port = null;
    if (isContextInvalidated(err)) orphaned = true;
  }
}

/**
 * Perform one request against the service, authenticated as the page is.
 *
 * Refuses rather than degrades when the credential is absent or belongs to
 * another origin: an unauthenticated call returns a login redirect, which
 * parses as "zero rows" and would look like a *completed* pull. A loud
 * failure is retried; a silent empty page is not.
 */
async function performFetch(msg: RelayFetchRequest): Promise<RelayFetchResult> {
  const fail = (error: string): RelayFetchResult => ({ type: "relay-fetch-result", id: msg.id, ok: false, status: 0, body: null, error });

  let target: URL;
  try {
    target = new URL(msg.url);
  } catch {
    return fail(t("badUrl"));
  }
  if (!auth) return fail(t("noCredentials"));
  if (auth.origin !== target.origin) return fail(t("wrongOrigin"));

  try {
    const res = await fetch(target.toString(), {
      method: msg.method ?? "GET",
      // No cookies: header-authenticated APIs do not use them, and sending
      // ambient credentials where they are not needed only widens what the
      // request carries. If your service is cookie-authenticated, this is the
      // one line to change — and then the header allowlist may be empty.
      credentials: "omit",
      headers: {
        Accept: "application/json",
        ...(msg.body ? { "Content-Type": "application/json" } : {}),
        ...auth.headers,
      },
      body: msg.body ? JSON.stringify(msg.body) : undefined,
    });
    const text = await res.text();
    return { type: "relay-fetch-result", id: msg.id, ok: res.ok, status: res.status, body: jsonOrNull(text) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** The *presence* of a credential and its origin, never the credential. */
function describeSelf(id: string): RelayStatusResult {
  return { type: "relay-status-result", id, authenticated: auth !== null, authOrigin: auth?.origin ?? null, pageUrl: window.location.href };
}

function jsonOrNull(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

type TapPost = { source?: unknown; origin?: unknown; headers?: unknown };

window.addEventListener("message", (event) => {
  // Same-origin only: another frame must not be able to inject fabricated
  // "captured" records into the host through us, nor hand us a credential.
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as TapPost | null;
  if (!data) return;

  if (data.source === AUTH_MESSAGE) {
    if (typeof data.origin === "string" && typeof data.headers === "object" && data.headers !== null) {
      auth = { origin: data.origin, headers: data.headers as Record<string, string> };
    }
    // Deliberately not forwarded: the credential has no business leaving this script.
    return;
  }

  if (data.source === TAP_MESSAGE) {
    if (orphaned) return;
    try {
      chrome.runtime.sendMessage({ type: "tap", payload: data }).catch(() => {
        // The worker may be mid-restart; the record will be seen again.
      });
    } catch (err) {
      // `sendMessage` throws **synchronously** on an invalidated context, so
      // the `.catch` above never gets attached — not a duplicate of it.
      if (isContextInvalidated(err)) orphaned = true;
    }
  }
});

connect();
```

## Job 2 is the one people get wrong: keeping the worker alive

An MV3 service worker is evicted about 30 s after its last **event**. An open
port is not an event; a message on it is. The relay therefore pings every 20 s.
Before the ping existed the "port keeps the worker alive" story was fiction:
the worker died half a minute after every poll, the relay reconnected a second
later and woke it, and the cadence held by accident of that cycle.

The worker side counts *any* live port ([service-worker-loop.md](service-worker-loop.md));
two service tabs are two ports, and closing one must not stop the other.

## Job 3: replaying the page's own authentication

`performFetch` refuses rather than degrades when the credential is absent or
belongs to another origin. An unauthenticated call to most APIs returns a login
redirect, which parses as "zero rows" and would look like a **completed** pull.
A loud failure is retried; a silent empty page is not.

`credentials: "omit"` is deliberate for header-authenticated services: sending
ambient cookies where they are not needed only widens what the request
carries. For a **cookie-authenticated** service, change that one line to
`"include"`, export an empty header allowlist from the adapter, and the same
origin check still applies. Do not request the `cookies` permission — the
browser attaches the cookie itself.

## Orphaned content scripts

Reloading or updating the extension leaves content scripts already running in
open tabs alive on the page but detached from the extension: every
`chrome.runtime.*` call throws "Extension context invalidated". That state is
terminal — only loading the page again injects fresh scripts — while the
failures it is confused with (a worker mid-restart, a port replaced by an
update) are worth retrying. Pointing the reconnect loop at a dead context
produced an uncaught error every second, forever, in every open tab.

```ts
/**
 * Telling an orphaned content script apart from a transient failure.
 *
 * Reloading or updating an extension leaves the content scripts already running
 * in open tabs alive on the page but detached from the extension: every
 * `chrome.runtime.*` call from then on throws. That state is **terminal** —
 * only loading the page again injects fresh scripts — while the failures it is
 * easily confused with (a service worker mid-restart, a port replaced by an
 * update) are worth retrying.
 *
 * Getting it wrong is not cosmetic in either direction: retrying a dead context
 * produces an uncaught error every second for as long as the tab stays open,
 * and giving up on a live one silently stops syncing.
 *
 * Matched on the message because Chrome gives no error code for it.
 */
export function isContextInvalidated(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Chrome has shipped both "Extension context invalidated." and the shorter
  // form; other surfaces phrase it as a message-port failure with the same cause.
  return /context invalidated|Extension context|message port closed/i.test(err.message);
}
```

Two places the distinction has to be made, and they differ:
`chrome.runtime.sendMessage` throws **synchronously** on an invalidated
context, so a `.catch` on the returned promise never sees it — the `try` around
the call is not a duplicate of the `.catch`.

## The same-origin guard on `message`

`event.source !== window || event.origin !== window.location.origin` is what
stops another frame on the page from injecting fabricated "captured" records
into the host through the extension, or handing it an attacker-chosen
credential to replay. Keep it.

## The cross-context contract

```ts
/**
 * Messages crossing the three extension contexts. One file, so a change to a
 * shape breaks compilation on both sides instead of at runtime, on a machine
 * nobody is watching.
 *
 * Note what is absent: no headers. The worker never names a credential, and
 * the relay attaches the page's own auth headers itself — so there is no field
 * here through which one could travel.
 */

export type RelayFetchRequest = {
  type: "relay-fetch";
  id: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
};

export type RelayFetchResult = {
  type: "relay-fetch-result";
  id: string;
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
};

export type TapMessage = {
  type: "tap";
  payload: { url: string; status: number; method: string; body: unknown };
};

/**
 * Asks the relay what it holds. Answered over the same port as a fetch, because
 * the credential state lives in the content script and nowhere else.
 * What comes back: whether a credential exists and which origin it belongs to.
 * **Never the credential.**
 */
export type RelayStatusRequest = { type: "relay-status"; id: string };

export type RelayStatusResult = {
  type: "relay-status-result";
  id: string;
  /** True once the page has made an authenticated request this tab saw. */
  authenticated: boolean;
  /** The origin the captured headers belong to, for the "wrong host" case. */
  authOrigin: string | null;
  /** Where the relay is running, so a wrong tab is visible. */
  pageUrl: string;
};

/**
 * A heartbeat from the relay, every twenty seconds while its port is open.
 * Carries nothing; its arrival is the point. An MV3 service worker is evicted
 * after 30 s without an *event*, and a port that is merely open is not one —
 * only traffic on it resets the timer.
 */
export type RelayPing = { type: "relay-ping" };

/** From the options page right after pairing: poll now, do not wait a minute. */
export type PollRequest = { type: "poll" };

export type DiagnoseRequest = { type: "diagnose"; connectionId: string };

/** One line on the diagnostics screen. */
export type DiagnosisCheck = {
  id: string;
  label: string;
  /**
   * `warn` is "works, but not the way you probably expect"; `fail` is "this is
   * why nothing is happening"; `info` is a fact about how the product is built
   * or a state that passes on its own, and does **not** count toward the
   * summary — otherwise no healthy install can ever summarise as "working".
   */
  state: "ok" | "info" | "warn" | "fail";
  detail: string;
};

/**
 * What the worker reports for one connection. Split by direction: records up
 * and commands down are two channels that fail independently, and one number
 * for both would call a healthy upload with a dead command path "connected".
 */
export type Diagnosis = {
  checks: DiagnosisCheck[];
  up: {
    queued: number;
    dropped: number;
    acceptedLastPost: number;
    duplicatesLastPost: number;
    lastPostAt: number | null;
  };
  down: {
    commandsLastPost: number;
    /** False while the adapter's write path is unverified. */
    writeSupported: boolean;
  };
};
```

## Checklist

- [ ] Ping interval below the worker's idle timeout with margin (20 s of 30 s)
- [ ] Credential never leaves `relay.ts` — not to the worker, not to storage
- [ ] Origin check on every replayed request
- [ ] `isContextInvalidated` used in both the async and the synchronous throw paths
- [ ] `message` listener checks source **and** origin
