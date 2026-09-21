# Manifest and permissions

Web Store review turns on the permission list, and so does the user's trust.
The manifest below asks for the minimum; the rationale file next to it is the
document to show a reviewer.

## manifest.json

Replace `example.invalid` with the service's hosts. List **both** the page host
and the API host if they differ (a panel served from `app.service.com` calling
`api.service.com` needs both in `host_permissions`, and the content scripts
match the page host only). Verify against live traffic; do not assume.

```json
// extension/manifest.json
{
  "manifest_version": 3,
  "name": "Connector: <host app> and <service>",
  "version": "0.0.0",
  "description": "Syncs your own <service> data with <host app>, from the session you are already signed in to. No password is ever stored or sent.",
  "minimum_chrome_version": "120",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://example.invalid/*"],
  "optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://example.invalid/*"], "js": ["net-tap.js"], "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://example.invalid/*"], "js": ["content.js"], "world": "ISOLATED", "run_at": "document_start" }
  ],
  "options_page": "options.html",
  "action": { "default_title": "Connector", "default_popup": "popup.html" }
}
```

Points that look like detail and are not:

- **Two content scripts on the same match**, one per world, both at
  `document_start`. The tap must be installed before the page's first request.
- **`background.type: "module"`**: the worker bundle is ESM; the content
  scripts are not and must not be ([build-and-package.md](build-and-package.md)).
- **`optional_host_permissions: https://*/*`** is not a request for every site.
  It is what lets the options page ask for **one** origin, the host app the
  user types, at pairing time (`chrome.permissions.request`). Without it the
  host origin would have to be known at publish time, which for a multi-tenant
  host it is not.
- **Loopback on plain HTTP** is for development only. Not `http://*/*`: a
  pairing token must never travel in the clear to a real host.
- **`minimum_chrome_version: 120`.** `world: "MAIN"` in the manifest and the
  promise-returning `chrome.*` APIs the hand-written types assume.

## PERMISSIONS.md

Ship this file with the extension and keep it true. Adding a permission is a
decision recorded here, not a convenience.

```markdown
<!-- extension/PERMISSIONS.md -->
# Why each permission is here

Web Store review turns on this list, and so does the user's trust. Every entry
is the minimum that makes the feature work; adding to it is a decision, not a
convenience.

| Entry | Why | Why not more |
|---|---|---|
| `storage` | The pairing token, the offline buffer and the last cursor. | `unlimitedStorage` is **not** requested: the buffer is deliberately bounded and reports what it drops. |
| `alarms` | Wakes the service worker when no service tab is open. | none |
| `host_permissions: <service hosts>` | The pages the tap runs on and the API host they call: list **both** if they differ (verify against live traffic). | **Not `<all_urls>`.** The extension can see exactly one service and nothing else on the machine. |
| `optional_host_permissions: https://*/*` | The host app's origin differs per tenant and is not knowable at publish time. Granted **at pairing**, for that one origin, by the person pairing. | Requesting every origin up front would be the single biggest red flag on the listing, and untrue. |
| `optional_host_permissions: http://localhost/*`, `http://127.0.0.1/*` | Development only: a dev server runs on plain HTTP. Loopback only. | Not `http://*/*`: a pairing token must never travel in the clear to a real host. |

Deliberately absent:

- **`tabs`**: never enumerate or read the user's tabs. The popup's "open the
  service" calls `chrome.tabs.create`, which needs **no** permission.
- **`scripting`**: the MAIN-world tap is declared in the manifest.
- **`cookies`**: nothing is read out of the cookie jar. The extension replays
  the headers it observes the page itself sending, only to the origin they came
  from, never stored, never sent to the host app.
- **`webRequest`**: a network-level interceptor would see traffic beyond the
  service. Patching `fetch` inside the service's own page sees strictly less.

## Single purpose

> Synchronise one user's own <service> data between <service> and that user's
> <host app>, from the session the user is already signed in to.
```

## What is deliberately absent, and what it costs

| Not requested | What it would buy | Why the cost is wrong |
|---|---|---|
| `tabs` | finding an already-open service tab from the popup | reads every tab title; the popup opens a new tab instead, which needs no permission |
| `scripting` | injecting the tap at runtime | the manifest declaration does it, statically and reviewably |
| `cookies` | reading the service's session cookie | header replay from observed traffic needs nothing from the jar; for a cookie-authenticated service the relay's `credentials` line is the one to change, not this list |
| `webRequest` | intercepting at the network layer | sees every site's traffic; patching `fetch` inside one page sees strictly less |
| `unlimitedStorage` | an unbounded offline buffer | an unbounded queue is not a safer place to lose data, only a quieter one, see [offline-queue.md](offline-queue.md) |

## Single purpose

The listing's "single purpose" statement should name one service and one host
app. One adapter per build keeps it true; a second service is a second listing
or a deliberately broadened statement, not a quiet addition.

## Self-hosted install versus the Web Store

Until a listing exists, the host can serve the zip that
[build-and-package.md](build-and-package.md) produces and walk the user through
"load unpacked". Two things to state on that page rather than let be
discovered: an unpacked install **does not auto-update**, and Chrome nags about
developer mode on every launch. If review refuses the listing, enterprise policy
installation on managed machines remains.

## Checklist

- [ ] Page host and API host both verified against live traffic and listed
- [ ] `PERMISSIONS.md` updated for every entry, with the "why not more" column
- [ ] No `<all_urls>`, no `tabs`, no `cookies`, no `webRequest`, no `unlimitedStorage`
- [ ] Single-purpose statement names one service and one host app
- [ ] Install page states "no auto-update" for unpacked installs
