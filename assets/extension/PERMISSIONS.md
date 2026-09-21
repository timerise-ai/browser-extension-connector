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
