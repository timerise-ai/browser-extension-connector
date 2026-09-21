# Provenance

The engineering ledger for this skill: what the audit of the earlier implementation changed and how the
templates verify it, what was kept deliberately and why it is safe, and what was designed here and has never
run in production. Audited on 2026-09-16 against a connector extension that had been carrying one service's
data into a host app for months, with an architecture note kept alongside it recording every incident. The
service adapter, the host's own vocabulary and the server implementation stayed behind; the runtime, the seam
and the hardening travelled.

Read this before simplifying anything. Every odd-looking part of the templates has an entry here.

## Fixed in the templates

### 1. A progress-only post discarded the commands it was handed

The pull step posted a second request per tick carrying only cursor progress, and ignored that response. The
host claims commands under a lease on **every** post, so any command that became due between the two posts
was leased, had its attempt counter incremented, and never ran. Past the attempt cap it was marked failed
without ever having executed, while the browser looked healthy. Confirmed by reading the host's sync handler
and its claim function.
**Shipped:** one `exchange()` path for every post and `handleResponse()` for every answer, see
[sync-engine.md](sync-engine.md); pinned by `engine.test.ts`.

### 2. Two service tabs, one port slot

The worker kept only the most recently connected relay port. Closing the newer tab nulled the slot while the
older tab's port was alive; every pull and command then failed "no service tab" and the loop fell to the slow
cadence until a tab was reopened.
**Shipped:** `PortRegistry`, see [service-worker-loop.md](service-worker-loop.md); pinned by `ports.test.ts`.

### 3. Batch ids were minted per attempt

The comment promised a retried post would be recognisable in the host's log; the id was `Date.now()` per
attempt, so it never was, and two batches in one millisecond would have collided.
**Shipped:** an id keyed on the batch's content plus a sequence, see [sync-engine.md](sync-engine.md); pinned
by `engine.test.ts`.

### 4. Every user-facing string was a literal, in one language

Options page, popup, diagnostics and worker error messages were written inline in the team's own language,
including the strings that travel to the host in `error`.
**Shipped:** `strings.ts` with keys and English defaults, see
[popup-and-strings.md](popup-and-strings.md).

### 5. Small: the body size cap counted characters and was named as bytes

Renamed `MAX_BODY_CHARS`; behaviour unchanged.

## Kept deliberately

- **`credentials: "omit"` on both the host and the service requests.** Looks like an oversight; it is the
  credential boundary. One line changes for a cookie-authenticated service, and the same-origin check stays.
- **Channel-name constants duplicated between the tap and the relay.** Importing would bundle the tap into
  the isolated world and loop its own requests back into itself.
- **Hand-written `chrome.d.ts`.** The list is the permission review surface.
- **The popup never talks to the worker.** A status that is only true because you are looking at it is not a
  status.
- **`info` excluded from the diagnostics summary.** While it counted, no install could ever summarise as
  "working".
- **Unknown command kinds left unacknowledged.** A newer build gets them, rather than this one reporting a
  permanent failure on its behalf.
- **The buffer is bounded at 2,000 records and `unlimitedStorage` is not requested.** An unbounded queue is
  not a safer place to lose data, only a quieter one, and the permission is a cost on the listing.

## Added, designed here and not proven in production

- **The generalised adapter seam.** The earlier implementation had one method per noun of the service it
  spoke to. They collapsed into `pull(kind, ...)` and `execute(command)`, and the host directive became
  `pull: {kind, cursor, pageSize}`. The rules those methods encoded survive as the table in
  [adapter-seam.md](adapter-seam.md).
- **`Engine` as an injectable class.** The worker was one module with its state in module variables and no
  tests above the queue. The split is what made fixes 1 and 3 testable.
- **Build-time injection of the tap's config from the adapter.** The URL pattern and the header names were
  literals inside the tap.
- **`PortRegistry`.**
- **A `stub` adapter**, so the tree builds and boots with no service wired.

## Not carried

- The service adapter and its fixtures: a separate skill on top of this one.
- The host's routes, staging schema, apply logic, merge and review queues, and cron: described as a contract
  in [server-contract.md](server-contract.md).
- The host's console UI for connections: described as an operator surface in
  [operations.md](operations.md).

## Verified, and not

Every template compiles under `strict` and `--noUncheckedIndexedAccess` against the hand-written
`chrome.d.ts`, the 70 tests pass, and the esbuild build and the zip round-trip, all run on TypeScript 7.0.2,
vitest 5.0.1 and Node 22.21.1. The template `tsconfig.json` carries no `baseUrl`: TypeScript 7 removed the
option and fails the whole config with `TS5102`, verified by running that version against this tree.

**Not verified here:** behaviour inside a real Chrome, meaning worker eviction, alarm timing and the
MAIN-world tap on a live page. Those claims come from the earlier implementation's own history rather than
from a run of this tree. Web Store review of the manifest is likewise untested.

## If you are hardening a connector you already have

Fix order, most damaging first: 1 (commands burned during pulls), 2 (two tabs), 4 (strings), 3 (batch ids).
