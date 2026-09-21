/**
 * Constants the service worker shares with its tests. Split out of `index.ts`
 * because that module installs listeners and starts a timer at import time —
 * importing it from a test would boot the extension.
 */

/**
 * How many buffered records go up in one post. Must stay at or below the host's
 * `MAX_RECORDS_PER_BATCH`; `queue.test.ts` asserts the relationship, because
 * the wire is imported type-only and a runtime import would drag the host's
 * validator into the worker.
 */
export const MAX_RECORDS_PER_POST = 200;

/** The keep-alive port's name; the relay connects with it. */
export const KEEPALIVE_PORT = "connector-keepalive";

/** The once-a-minute floor when no service tab keeps the worker alive. */
export const ALARM = "connector-sync";

/** Default cadence until the host says otherwise. */
export const DEFAULT_POLL_MS = 30_000;
/** Cadence when no service tab is open: the alarm floor. */
export const SLOW_POLL_MS = 60_000;
/** How long one request through the relay may take. */
export const RELAY_TIMEOUT_MS = 30_000;
