# Architecture

A connector that acts on a web service with no public API, from inside the
user's own signed-in browser. Three execution contexts inside one MV3
extension, one HTTP channel to the host app, and a hard boundary around the
credential that makes the whole thing possible.

## The shape

```
 HOST APP (server)                 USER'S BROWSER (Chrome, MV3 extension)                SERVICE
 -----------------                 --------------------------------------                -------
 pair: PIN, then token --------->  options page ---- saves pairing ---+
                                                                     |
 sync: records + telemetry up <--  service worker (the loop) <--- relay (ISOLATED) <--- tap (MAIN world)
       commands + pacing down -->   - offline buffer          |  port + 20 s ping     |  patches page fetch/XHR
                                    - one client per pairing  |  replays the page's   |  captures JSON responses
                                    - commands to execute() --+   own auth headers,   |  + allowlisted auth headers
                                    - pull step to pull() ----+   same origin only ---+  window.postMessage
```

One request type sustains the runtime: the worker posts to the host's sync
endpoint, sending records and telemetry up and receiving commands and pacing
down. Health, pulls, writes back into the service and the kill switch all ride
that channel, which is why **no inbound connection to the user's machine is
needed** and the module works through NAT and whatever the router is doing.

## The three contexts, and why each exists

| Context | File | Sees | Cannot |
|---|---|---|---|
| MAIN world | `inject/net-tap.ts` | the page's own `fetch`/XHR and their responses | any `chrome.*` API; import anything |
| ISOLATED world | `content/relay.ts` | `chrome.runtime`, the tap's `postMessage` | the page's responses |
| Service worker | `background/*` | storage, alarms, the host app | the page, the service's session |

An isolated-world content script gets its own copies of `fetch` and
`XMLHttpRequest`, so it cannot see a single response the page receives. Only
MAIN-world code can, declared with `content_scripts[].world: "MAIN"`. That is
not a preference: it is the only thing that works. The relay exists because
MAIN-world code has no extension APIs; the worker exists because content
scripts die with the tab.

## Read by observation, then pull and act on demand

The tap **observes**: whatever the user opens is captured as a side effect of
them working, which keeps the traffic profile identical to a person at a desk.
Everything else (pulling a page of history, refreshing a list, writing
something into the service) is an explicit request from the host, executed
sequentially and throttled, shaped like a request the page itself makes.

Both need the same thing: to issue a request the service will accept. Many
services authenticate their own API with **headers** (a bearer token, an API
key, a CSRF token), not cookies, and `credentials: "include"` returns nothing.
So the tap records the allowlisted headers the page *already sent*, hands them
to the relay, and the relay replays them on the extension's own calls. A live
credential therefore sits in the content script for the life of the tab.

## The credential rules

Four structural limits keep that defensible, and each is enforced in code
rather than promised:

1. **Read only from requests the page itself made**: never minted, never
   prompted for, never read out of storage or the cookie jar.
2. **Replayed only to the origin it was captured from**, checked on every call.
3. **Never persisted**: it lives in `relay.ts` memory and dies with the tab.
4. **Never sent to the host**: the sync payload is a fixed field set with
   nowhere to put a token, and `messages.ts` has no headers field by design.

The threat this is compared against is the alternative: the user handing the
host their service password, which works from anywhere, forever, and usually
breaks the service's terms. Recorded in [provenance.md](provenance.md).

## Poll, do not stream

A short POST every 30 s is cheaper than a socket that must survive a laptop's
day, and it reconnects for free. The host paces the client (`pollMs`) and the
client backs off on its own when the host is down: a host that is down cannot
tell anyone to slow down.

## The cadence has an honest ceiling

MV3 evicts an idle service worker after ~30 s and `chrome.alarms` will not
fire more than once a minute. So:

| State | Cadence | Why |
|---|---|---|
| A service tab is open | the host's `pollMs` (30 s default) | the relay's port **traffic**, a 20 s ping, keeps the worker alive |
| No service tab | once a minute | the alarm floor |
| Browser closed | nothing | the host's derived health badge is how anyone finds out |

"Within tens of seconds" is true exactly while somebody is working in the
service, which is when it matters. Say so in your runbook rather than letting
the number be discovered, see [operations.md](operations.md).

## What the host does with it

The host stages records, validates each one on its own, computes the content
hash, applies off the request, hands out commands under a lease and derives
health from the last heartbeat. That side is a **contract**, not part of this
skill's templates, see [server-contract.md](server-contract.md).

## Where things live

| Concern | Reference |
|---|---|
| Manifest, permissions, single purpose | [manifest-and-permissions.md](manifest-and-permissions.md) |
| The MAIN-world tap | [main-world-tap.md](main-world-tap.md) |
| The relay and the cross-context messages | [relay.md](relay.md) |
| Worker plumbing: ports, alarm, bootstrap | [service-worker-loop.md](service-worker-loop.md) |
| The sync engine: tick, commands, pulls | [sync-engine.md](sync-engine.md) |
| Diagnostics ladder | [diagnostics.md](diagnostics.md) |
| Offline buffer, lane, routing | [offline-queue.md](offline-queue.md) |
| Host client and stored pairings | [host-client.md](host-client.md) |
| The adapter seam | [adapter-seam.md](adapter-seam.md) |
| Pairing screen | [pairing-ui.md](pairing-ui.md) |
| Popup and strings | [popup-and-strings.md](popup-and-strings.md) |
| Build, formats, zip | [build-and-package.md](build-and-package.md) |
| Shipped tests | [tests.md](tests.md) |
