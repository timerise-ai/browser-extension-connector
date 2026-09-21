# Provenance

Extracted on 2026-09-16 from a production Chrome extension that syncs a
salon's booking-portal data (one vendor, no partner API) into the salon's own
management console, running on reception PCs since August 2026. ~3.6k lines
of extension source and ~2.4k of tests, plus a 1,100-line architecture note
recording every incident. The vendor adapter, the salon vocabulary and the
server implementation were left behind; the runtime, the seam and the
hardening travelled.

Fidelity: **hardened**. Templates are the fixed version; every deviation is
listed here.

## Fixed in the templates

### 1. A progress-only post discarded the commands it was handed

The pull step posted a second request per tick carrying only cursor
progress, and ignored that response. The host claims commands under a lease
on **every** post, so any command that became due between the two posts was
leased, had its attempt counter incremented, and never ran — and after the
attempt cap was marked failed without ever having executed. Invisible: the
command simply "failed" in the host's log while the browser looked healthy.
Confirmed by reading the host's sync handler and its claim function.
**Shipped:** one `exchange()` path for every post and `handleResponse()` for
every answer — [sync-engine.md](sync-engine.md); pinned by `engine.test.ts`.

### 2. Two service tabs, one port slot

The worker kept only the most recently connected relay port. Closing the
newer tab nulled the slot while the older tab's port was alive; every pull
and command then failed "no service tab" and the loop fell to the slow
cadence until a tab was reopened.
**Shipped:** `PortRegistry` — [service-worker-loop.md](service-worker-loop.md);
pinned by `ports.test.ts`.

### 3. Batch ids were minted per attempt

The comment promised a retried post would be recognisable in the host's log;
the id was `Date.now()` per attempt, so it never was — and two batches in one
millisecond would have collided.
**Shipped:** an id keyed on the batch's content plus a sequence —
[sync-engine.md](sync-engine.md); pinned by `engine.test.ts`.

### 4. Every user-facing string was a literal in one language

Options page, popup, diagnostics and worker error messages were hardcoded
Polish, including the strings that travel to the host in `error`.
**Shipped:** `strings.ts` with keys — [popup-and-strings.md](popup-and-strings.md).

### 5. Small: the body size cap counted characters, named as bytes

Renamed `MAX_BODY_CHARS`; behaviour unchanged.

## Kept deliberately

- **`credentials: "omit"` on both the host and the service requests.** Looks
  like an oversight; it is the credential boundary. One line changes for a
  cookie-authenticated service, and the same-origin check stays.
- **Channel-name constants duplicated between the tap and the relay.**
  Importing would bundle the tap into the isolated world and loop its own
  requests back into itself.
- **Hand-written `chrome.d.ts`.** The list is the permission review surface.
- **The popup never talks to the worker.** A status that is only true because
  you are looking at it is not a status.
- **`info` excluded from the diagnostics summary.** While it counted, no
  install could ever summarise as "working".
- **Unknown command kinds left unacknowledged.** So a newer build gets them,
  rather than this one reporting a permanent failure on its behalf.
- **The buffer is bounded at 2,000 and `unlimitedStorage` is not requested.**

## Added (designed here, not proven in production)

- **The generalised adapter seam.** The source had salon-specific methods
  (`roster`, `catalogue`, `upcoming`, `backfillPage`, `createBlock`,
  `deleteBlock`). They collapsed into `pull(kind, …)` and `execute(command)`,
  and the host directive became `pull: {kind, cursor, pageSize}`. The rules
  the old methods encoded are preserved as a table in
  [adapter-seam.md](adapter-seam.md).
- **`Engine` as an injectable class.** The source's worker was one 885-line
  module with state in module variables and no tests above the queue. The
  split is what made fixes 1 and 3 testable.
- **Build-time injection of the tap's config from the adapter.** The source
  hardcoded the vendor's URL pattern and header names in the tap.
- **`PortRegistry`.**
- **A `stub` adapter**, so the tree builds with no vendor wired.

## Not carried

- The vendor adapter (~1,900 lines) and its fixtures: a separate skill.
- The host's routes, staging schema, apply logic, merge and review queues,
  and cron: described as a contract in [server-contract.md](server-contract.md).
- The host's console UI for connections.

## Verified, and not

Every template compiles under `strict` and `--noUncheckedIndexedAccess`
against the extracted `chrome.d.ts`; 70 tests pass; the esbuild build and the
zip round-trip. **Not verified here:** behaviour inside a real Chrome (worker
eviction, alarm timing, the MAIN-world tap on a live page) — those claims come
from the source's production history, not from this extraction — and Web
Store review of the manifest.

## If you are porting the original instead

Fix order, most damaging first: 1 (commands burned during pulls), 2 (two
tabs), 4 (strings), 3 (batch ids).
