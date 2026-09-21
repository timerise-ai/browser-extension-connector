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
