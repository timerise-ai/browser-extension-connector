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
