# The adapter seam

The seam that keeps this extension from being a *one-service* extension.
Everything service-specific lives behind it: which URLs matter, how a
response becomes a record, how a write is issued. The worker, the queue, the
pairing flow and the host know nothing about any particular service.

**The adapter normalises; the host stores.** A service changing its response
shape is an extension release, which reaches users on its own through the Web
Store; it is never a host deploy. That is the difference between a fix taking
days and a fix taking a release train.

## src/adapters/types.ts

```ts
// extension/src/adapters/types.ts
import type { Ack, Command, ConnectorRecord } from "../wire";

/**
 * The seam that keeps this extension from being a <one-service> extension.
 *
 * Everything service-specific lives behind it: which URLs matter, how a
 * response becomes a record, how a write is issued. The worker, the queue, the
 * pairing flow and the whole host side know nothing about any particular
 * service. The division of labour is deliberate: **the adapter normalises, the
 * host stores.** A service changing its response shape is an extension release;
 * it is never a host deploy.
 *
 * One adapter per service, written as its own skill on top of this one.
 */
export type ConnectorAdapter = {
  /** Stable key; matches the host's provider enum and the pairing's `provider`. */
  readonly id: string;
  /** Hosts this adapter claims. Decides whether a tapped response belongs to it. */
  readonly hostPatterns: RegExp[];
  /** Where the popup's "open the service" button goes. */
  readonly serviceHome: string;
  /**
   * Whether writes against the service have been verified on a live account.
   * While false, `execute` for a writing command must refuse rather than guess:
   * a write at a guessed endpoint either fails loudly (fine) or succeeds while
   * we misread the id it returns, leaving something in the user's account that
   * nothing can remove, because the id is the only key a delete may address.
   */
  readonly writeVerified: boolean;

  /**
   * Turn one observed response into zero or more records.
   *
   * Returning `[]` for anything unrecognised is the contract, not a fallback: a
   * service serves a hundred endpoints we do not care about, and throwing on
   * them fills the log with noise that hides a real parser break.
   */
  parse(observed: Observed): ConnectorRecord[];

  /** The service's own id for the signed-in account, if a response reveals it. */
  accountId(observed: Observed): string | null;

  /**
   * One page of a host-directed pull. `null` cursor starts from the beginning;
   * a `null` cursor in the result means the pull is finished.
   *
   * `account` is threaded through every call rather than captured at
   * construction: one browser may be paired to several accounts, and an
   * adapter that remembered "its" account would quietly walk the wrong one
   * after the second pairing.
   */
  pull?(kind: string, cursor: unknown, pageSize: number, http: ServiceHttp, account: string): Promise<Page>;

  /**
   * Perform one host command in the service. Return the ack to report; throw
   * only for a failure the caller should word itself. Deletes must be addressed
   * by `command.externalRef` only, never by time, title or matching text.
   */
  execute?(command: Command, http: ServiceHttp, account: string): Promise<Ack>;
};

export type Observed = {
  url: string;
  method: string;
  status: number;
  body: unknown;
};

export type Page = {
  records: ConnectorRecord[];
  /** `null` means the pull is finished. Opaque to everything above the seam. */
  cursor: unknown;
  /** Total rows, when the service reports one credibly: drives a progress bar. */
  total?: number | null;
  /** Cumulative rows behind the pull, in the same unit as `total`. Only the adapter can read its cursor. */
  done?: number;
  /** Rows the service sent and the adapter could not use. Reported, never swallowed: a hole nobody is told about is the failure this seam exists to avoid. */
  skipped?: number;
  /** Something the host should show: a row being retried, a shape not recognised. A page that silently returns the cursor it was given is a stall with no symptom. */
  warning?: string;
  /**
   * Why the pull stopped short, when it did, with `records` still holding
   * everything read first. Reported rather than thrown: a tab closing halfway
   * is ordinary, and the pages already read cost real requests.
   */
  error?: string;
};

/** A request performed in the service page's own session. See `relay.md`. */
export type ServiceHttp = (req: {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}) => Promise<{ ok: boolean; status: number; body: unknown }>;
```

## Rules an adapter skill must keep

| Rule | Why |
|---|---|
| `parse` returns `[]` for anything unrecognised | a service serves a hundred endpoints we do not care about; throwing fills the log with noise that hides a real parser break |
| `parse` emits records that fit the host's limits (truncate display text, clamp numbers) | the host rejects a record that fails validation, and a rejected record is dropped from the buffer; truncating beats dropping, and `raw` keeps the original |
| `account` threaded per call, never captured at construction | one browser, two accounts: an adapter that remembered "its" account walks the wrong one after the second pairing |
| A pull page reports `done`/`total`/`skipped`/`warning` | the cursor is opaque above the seam, so only the adapter can say how far it got; a page that quietly returns the cursor it was given is a stall with no symptom |
| A partial pull returns `records` **and** `error` | a tab closing halfway is ordinary and the pages already read cost real requests; throwing would discard them to report the failure tidily |
| An empty **first** page of a pull is a failure, not "done" | a wrapper the parser does not recognise, a filtered list and a 200 that is really a login page all arrive as "no rows"; reading them as done shows a full progress bar over an import of nothing |
| Ask for the page size the page itself asks for | an endpoint that validates `per_page` against its own list answers an unfamiliar value with an empty collection: the failure above, self-inflicted |
| Pulls are sequential and throttled, shaped like the page's own requests | the whole argument for this design is that the traffic looks like a person working; twenty parallel fetches do not |
| Retry counts live in the cursor, not in memory | the cursor is the pull's only memory across worker evictions; a count in memory restarts at zero and retries one bad row forever |
| `writeVerified` gates every writing command | a write at a guessed endpoint either fails loudly (fine) or succeeds while we misread the id it returns, leaving something in the user's account nothing can remove |
| Deletes address `externalRef` only | never by time, never by matching text: a user's own hand-made entries look identical and deleting one is not recoverable |
| A create that succeeds but returns no id **throws** | the alternative is an entry only a human can remove |
| Timestamps: prefer an explicit-offset field; read naive local time as the account's zone, never as UTC | appending `Z` moves an entire archive by the zone offset, invisibly |
| Money: unparseable becomes `null`, never `0` | a "free" record is indistinguishable from a genuinely free one and wrong in every figure downstream |

## Placeholder and registry

```ts
// extension/src/adapters/stub.ts
import type { ConnectorAdapter } from "./types";

/**
 * A placeholder adapter so the runtime builds and boots with no service wired.
 * Replace with a real adapter (its own skill). Keep the two tap constants
 * exported from the adapter module: `build.mjs` reads them and injects them
 * into the MAIN-world bundle, which must not import anything.
 */

/** Which URLs the MAIN-world tap captures. Source of a RegExp, case-insensitive. */
export const TAP_CAPTURE = "/api/";
/**
 * Request headers the tap records for replay. An explicit allowlist, never
 * "whatever the page sent": tracing headers are noise, and copying a header we
 * do not understand is how a request starts carrying something it should not.
 */
export const TAP_AUTH_HEADERS: string[] = ["authorization"];

export const stubAdapter: ConnectorAdapter = {
  id: "stub",
  hostPatterns: [/^https:\/\/example\.invalid\//],
  serviceHome: "https://example.invalid/",
  writeVerified: false,
  parse: () => [],
  accountId: () => null,
};
```

```ts
// extension/src/adapters/index.ts
import type { ConnectorAdapter } from "./types";
import { stubAdapter } from "./stub";

/** Every adapter this build ships. A pairing's `provider` selects one by `id`. */
export const ADAPTERS: ConnectorAdapter[] = [stubAdapter];
```

## How an adapter skill plugs in

1. Replace `stub.ts` with `<service>/index.ts` (+ `parse.ts`, `endpoints.ts`),
   exporting the adapter object and the two tap constants.
2. Point `tap-config.ts` at it; list it in `ADAPTERS`; set `PROVIDER` in
   `options.ts`; set `serviceHome`.
3. Put the service's hosts in `manifest.json` and the rationale in
   `PERMISSIONS.md` ([manifest-and-permissions.md](manifest-and-permissions.md)).
4. Capture live responses into **redacted fixtures** and pin every parser
   with tests against them: a shape that was captured is worth more than a
   wrapper that was guessed. Record what was captured and what was inferred.
5. Keep `writeVerified: false` until a write has been created and deleted on a
   live account and the id round-trip confirmed.
6. Define the host's record kinds, pull kinds and command kinds together with
   the host ([server-contract.md](server-contract.md)).

## What observation cannot supply

The tap sees what the user opens. Three things it therefore never sees, and an
adapter should plan a pull for: reference lists opened once at setup and never
again (people, categories, catalogues); the **future** (anything scheduled
ahead, which nobody scrolls to); and deletions (a deleted item simply stops
being served, so a "table of contents" record for a range lets the host cancel
what is no longer listed, but only for a response the adapter can vouch is
complete).
