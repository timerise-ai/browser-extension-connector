# The popup and the strings map

## The popup is read-only, and does not wake the worker

Everything that changes state lives one click away in the options page,
because a popup closes the moment focus moves and a half-finished pairing in a
window that vanishes is worse than no shortcut.

It reads storage directly rather than asking the worker. Waking the worker to
render a popup would make opening the popup the thing that keeps the worker
alive, and a status that is only true because you are looking at it is not a
status. The numbers are what the last real poll wrote.

## src/popup/popup.html

```html
<!-- extension/src/popup/popup.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Connector</title>
    <!-- Structure only; the host supplies the look. Sized for the toolbar popup, which clips silently past ~600px tall. -->
    <style>
      :root { color-scheme: light dark; }
      body { font: 13.5px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; width: 340px; }
      section { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
      .conn { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
      .dot.ok { background: #12a150; } .dot.warn { background: #d18b00; } .dot.fail { background: #d13030; } .dot.idle { background: #888; }
      .label { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .when { font-size: 11.5px; opacity: .65; flex: none; }
      .note { font-size: 12px; opacity: .8; margin: 4px 0 0; }
      button { width: 100%; padding: 9px 12px; cursor: pointer; }
      button + button { margin-top: 8px; }
    </style>
  </head>
  <body>
    <h1>Connector</h1>
    <section>
      <h2>Connections</h2>
      <div id="connections"></div>
    </section>
    <button id="options" class="primary">Settings and connection test</button>
    <button id="service">Open the service</button>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

## src/popup/popup.ts

```ts
// extension/src/popup/popup.ts
import { ADAPTERS } from "../adapters";
import { loadLastPosts, loadPairings, type LastPost } from "../background/config";
import { DEFAULT_POLL_MS } from "../background/constants";
import { t } from "../shared/strings";

/**
 * The toolbar popup: the extension's front door.
 *
 * Deliberately read-only. Everything that changes state lives one click away
 * in the options page, because a popup closes the moment focus moves and a
 * half-finished pairing in a window that vanishes is worse than no shortcut.
 *
 * It reads storage directly rather than asking the service worker. Waking the
 * worker to render a popup would make opening the popup the thing that keeps
 * the worker alive, and a status that is only true because you are looking at
 * it is not a status. The numbers here are what the last real poll wrote.
 */

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Missing this many polls is a blip; more is worth a colour. Mirror it in the host. */
const STALE_AFTER_MS = 6 * DEFAULT_POLL_MS;

type Health = { state: "ok" | "warn" | "fail" | "idle"; note: string };

/**
 * What one connection is doing, from the last post alone. "Paused in the
 * host" outranks staleness: a connection that was switched off is doing
 * exactly what it was told, and calling that a fault teaches people to
 * ignore the colour.
 */
export function health(last: LastPost | undefined, now = Date.now()): Health {
  if (!last) return { state: "idle", note: t("neverPosted") };
  if (!last.ok) return { state: "fail", note: last.note ?? t("lastFailed") };
  if (!last.enabled) return { state: "warn", note: t("pausedInHost") };
  if (now - last.at > STALE_AFTER_MS) return { state: "warn", note: t("stale") };
  if (last.pulling) return { state: "ok", note: t("pulling") };
  return { state: "ok", note: t("listening") };
}

async function render(): Promise<void> {
  const box = $("connections");
  const [pairings, lastPosts] = await Promise.all([loadPairings(), loadLastPosts()]);
  if (pairings.length === 0) {
    box.replaceChildren(el("p", "note", t("noPairings")));
    return;
  }
  box.replaceChildren();
  for (const pairing of pairings) {
    const last = lastPosts[pairing.connectionId];
    const state = health(last);
    const row = el("div", "conn");
    row.append(
      el("span", `dot ${state.state}`),
      el("span", "label", pairing.label),
      el("span", "when", last ? new Date(last.at).toLocaleTimeString() : "-"),
    );
    box.append(row, el("p", "note", state.note));
  }
}

$("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/** Opens the service rather than searching for an existing tab: no `tabs` permission, and none requested. */
$("service").addEventListener("click", () => {
  const home = ADAPTERS[0]?.serviceHome;
  if (home) chrome.tabs.create({ url: home });
  window.close();
});

void render();
```

`health()` derives one of four states from the last post alone:

| Order | Condition | State | Why this order |
|---|---|---|---|
| 1 | no post yet | idle | "nothing sent yet" is not a fault |
| 2 | last post failed | fail | the note carries the reason (revoked, unreachable) |
| 3 | paused in the host | warn | outranks staleness: a paused connection is doing what it was told, and calling that a fault teaches people to ignore the colour |
| 4 | older than six polls | warn | one missed poll is a blip |
| 5 | a pull in progress | ok | says so, because "connected and idle" over a running pull reads as done |
| 6 | otherwise | ok | listening |

Mirror the staleness threshold in the host's health badge so the two never
disagree about the same connection.

"Open the service" calls `chrome.tabs.create` rather than searching for an
existing tab: the extension has no `tabs` permission and is not asking for one
to save a duplicate tab.

## src/shared/strings.ts

Every user-facing string, keyed, in one file. The host translates this file
and nothing else. Worker-side messages are here too because they travel to
the host in `SyncRequest.error` and appear on the connection card.

```ts
// extension/src/shared/strings.ts
/**
 * Every user-facing string in the extension, keyed. The host translates this
 * one file; nothing else in the extension carries a literal. Worker-side
 * messages travel to the host in `SyncRequest.error`, so they are here too.
 */
export const STRINGS = {
  // worker
  noServiceTab: "no service tab is open",
  serviceTimeout: "timed out waiting for the service to answer",
  serviceTabClosed: "the service tab was closed",
  accountUnknown: "account not recognised: open the service and load a page that shows it",
  hostUnreachable: "the host app did not answer",
  pairingRevoked: "pairing expired or was revoked: pair again in the extension settings",
  pullProgressNotSaved: "could not save pull progress in the host app",
  pullPaused: "pull paused",
  missingExternalRef: "no service id for this item",
  writeUnverified: "writing to the service is not yet verified on a live account",
  unknownCommand: "unknown command kind",
  // relay
  badUrl: "invalid address",
  noCredentials: "no service credentials seen yet: open the service and sign in",
  wrongOrigin: "credentials belong to a different origin than the request",
  // diagnostics
  checkPairing: "Pairing",
  notPairedHere: "This connection is not paired in this browser.",
  checkHost: "Host app",
  hostOk: "Answers and accepts data.",
  hostNoAnswer: "No answer from {origin}. Check the address and your connection.",
  checkEnabled: "Connection enabled",
  enabledOk: "Enabled in the host app.",
  enabledOff: "Paused in the host app. Enable it there.",
  checkServiceTab: "Service tab",
  serviceTabMissing: "No service tab is open. Pulls and commands need one, signed in.",
  checkSession: "Service session",
  sessionOk: "Signed in ({origin}).",
  sessionMissing: "The tab is open but no signed-in request has been seen yet. Load a page.",
  checkAccount: "Recognised account",
  accountMissing: "Account not recognised. Open a page in the service that shows it.",
  accountMismatch: "This connection is bound to account {bound}; the tab shows {observed}. Switch the service to the right account.",
  accountOk: "Account {account}",
  checkBuffer: "Offline buffer",
  bufferOk: "{queued} records waiting to be sent.",
  bufferDropped: "{queued} queued, {dropped} dropped after overflow. They will be observed again.",
  checkWrite: "Writes to the service",
  writeOn: "Enabled.",
  writeOff: "Disabled: writes are not yet verified on a live account. Records go up; commands that write do not run.",
  // options
  invalidHost: "Invalid host app address.",
  invalidPin: "The pairing code is 4 to 8 digits.",
  permissionDenied: "Without access to the host app's address the extension cannot send data.",
  wrongPin: "Wrong code.",
  noConnections: "This tenant has no connection yet. Create one in the host app.",
  chooseConnection: "Tenant: {name}. Choose a connection.",
  pairFailed: "Pairing failed.",
  listFailed: "Could not list connections.",
  serverFault: "{detail} ({status}): a fault on the host app's side, not in the pairing. Pass this message to whoever runs it.",
  networkFailed: "Could not reach {origin}. Check the address and your connection.{detail}",
  paired: "Paired with \"{label}\". Connecting to the host app...",
  unpairedLocally: "Removed from this browser. To revoke the token, disconnect it in the host app.",
  testConnection: "Test connection",
  unpair: "Disconnect",
  unpairConfirm: "Really disconnect?",
  rePair: "(pair again)",
  notChecked: "Not checked",
  checking: "Checking...",
  noReply: "No reply from the extension. Disable and re-enable it.",
  testFailed: "Test failed: {error}",
  summaryOk: "Working",
  summaryWarn: "Working with caveats",
  summaryFail: "Not working",
  upHeading: "Up, to the host app",
  downHeading: "Down, to the service",
  acceptedLast: "Accepted last time",
  duplicates: "Duplicates",
  queued: "Queued",
  dropped: "Dropped",
  lastContact: "Last contact",
  commandsLast: "Commands last time",
  writeState: "Writes",
  writeActive: "active",
  writeDisabled: "disabled",
  // popup
  noPairings: "No paired connections. Pair the extension with the host app in settings.",
  neverPosted: "Nothing sent yet.",
  lastFailed: "The last attempt failed.",
  pausedInHost: "Paused in the host app.",
  stale: "Quiet for a while. Open settings and run a test.",
  pulling: "Pulling data from the service.",
  listening: "Connected and listening for changes.",
} as const;

export type StringKey = keyof typeof STRINGS;

/** `t("hostNoAnswer", { origin })`: `{name}` placeholders, nothing cleverer. */
export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}
```

Rules: `{name}` placeholders only; no markup; nothing that could carry a
credential (the relay never reports a header value, only its presence and
origin). Keep strings short, several land in a card column, not a log.

## Checklist

- [ ] Popup imports from `config.ts` and `constants.ts`, never from `index.ts`
- [ ] `STALE_AFTER_MS` matches the host's badge
- [ ] Every literal in `options.ts`, `popup.ts`, `engine.ts`, `relay.ts` goes through `t()`
