# Operations

What an operator sees, what they can do, and the ladder to climb when
"nothing is syncing". Written for the host's runbook; adapt the names.

## The model in one paragraph

The extension runs in the user's own signed-in browser. It reads what the
user opens in the service, pulls what the host asks for, and writes what the
host commands, in the user's session, with the page's own credentials, which
never leave the tab. Everything reaches the host through one poll. It works
when the browser does: closed laptop, no sync; signed-out service, no pulls;
both surface as a derived health badge in the host, neither is silently absorbed.

## What the host must show per connection

| Column | Source | Why it is state, not configuration |
|---|---|---|
| Health | derived from `last_seen_at` on read | a stored status needs a cron; a dead cron makes everything look healthy |
| Last contact / last data | heartbeat | "quiet for 4 min" is actionable; "connected" is not |
| Agent version | `agentVersion` | a machine on a stale build is invisible otherwise |
| Queued / dropped | `queued`, `dropped` | a buffer that only grows beside nothing accepted is the clearest symptom of a wedged channel; before it was reported, that number lived only on the user's machine |
| Last error | `error` (`null` clears) | a pull blocked on a closed tab used to end in a worker console nobody opens |
| Rejected records | step 2 of the sync handler | a schema refusal from the host's side, which the extension cannot report because from its side the post succeeded |
| Pull progress | `pull.done / total`, `skipped` | a bar pinned at zero is either slow or dead; `skipped` is the hole the user must be told about |

Alert on silence, pushed and debounced to once a day, to whoever can act and
not to the person whose browser stopped reporting.

## The diagnostics ladder

Start with **"Test connection"** in the extension's options page. It runs a
real poll and lists the checks in pipeline order; the first failure is the
thing to fix ([diagnostics.md](diagnostics.md)).

| Symptom | Likely cause | Fix |
|---|---|---|
| Host: no answer | wrong address, dead deploy, origin permission missing | the message names the origin; check each |
| Host: 401 | disconnected in the host, re-paired from another browser, host rotated its pepper | pair again |
| Enabled: paused | new connections default to off | enable it in the host |
| Service tab: none | pulls and commands need a signed-in tab | open the service, sign in, leave the tab |
| Session: not seen | tab open, tap saw no authenticated request | load a page that calls the API; if it never turns green after that, the tap is not running: check the built bundle format |
| Account: unknown | no response yet revealed the account id | open a page in the service that shows it |
| Account: mismatch | bound to one account, tab shows another | switch the service to the right account; records from the wrong one are discarded, not dropped |
| Buffer: dropped N | long offline period overflowed the buffer | nothing is permanently lost: pulls re-fetch, live records are re-observed |
| Writes: disabled | adapter's write path unverified | product-wide, not this install |

## Silence with the browser open

If the host says "quiet" while the browser is open and the service is signed
in, suspect the worker cadence: the alarm re-created on every startup (never
fires), no immediate poll at bootstrap, or a port without traffic
([service-worker-loop.md](service-worker-loop.md)). All three read as
boilerplate and all three have happened.

## "Records arrive but nothing appears"

That is the host's apply step, not the extension: look at the staged rows'
status and last error. A record the host cannot place yet (waiting on a
reference it has not received) should be retried, not failed; one it can never
place should be named.

## When the service changes

A change of **appearance** does not matter: nothing reads the screen. A change
in **how data is served** shows as: the log goes quiet despite "connected", or
records arrive with empty fields. The repair is an extension release, not a
host deploy: capture the new responses, fix the adapter's parser, run its
fixture tests, bump the version, publish. Raw bodies kept on the host let the
window of bad parsing be re-processed without asking the user for anything.

## Switching off

| Action | Effect |
|---|---|
| Pause (host toggle) | extension keeps checking in at the slow cadence; card says "paused" |
| Disconnect one browser (host) | one credential row deleted; that install gets 401 and says "pair again" |
| Rotate the host's token pepper | every pairing invalidated at once |
| Uninstall the extension | the host sees silence; nothing on the machine holds a service credential |

## Extension reloads

After an extension update, content scripts in open service tabs are orphaned:
they neither capture nor relay until the page is reloaded. Say so in the
install notes; the relay goes silent on purpose rather than erroring every
second ([relay.md](relay.md)).

## Not built here

- Log export from the popup (the worker's console is the only log).
- A per-service "screens that matter" hint in the popup: observation makes
  the user's habits part of the data path, and nothing tells them so; an
  adapter skill should add it.
- Web Store listing mechanics; the zip is the self-hosted stopgap.
