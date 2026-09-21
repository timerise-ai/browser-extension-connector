/**
 * Messages crossing the three extension contexts. One file, so a change to a
 * shape breaks compilation on both sides instead of at runtime, on a machine
 * nobody is watching.
 *
 * Note what is absent: no headers. The worker never names a credential, and
 * the relay attaches the page's own auth headers itself — so there is no field
 * here through which one could travel.
 */

export type RelayFetchRequest = {
  type: "relay-fetch";
  id: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
};

export type RelayFetchResult = {
  type: "relay-fetch-result";
  id: string;
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
};

export type TapMessage = {
  type: "tap";
  payload: { url: string; status: number; method: string; body: unknown };
};

/**
 * Asks the relay what it holds. Answered over the same port as a fetch, because
 * the credential state lives in the content script and nowhere else.
 * What comes back: whether a credential exists and which origin it belongs to.
 * **Never the credential.**
 */
export type RelayStatusRequest = { type: "relay-status"; id: string };

export type RelayStatusResult = {
  type: "relay-status-result";
  id: string;
  /** True once the page has made an authenticated request this tab saw. */
  authenticated: boolean;
  /** The origin the captured headers belong to, for the "wrong host" case. */
  authOrigin: string | null;
  /** Where the relay is running, so a wrong tab is visible. */
  pageUrl: string;
};

/**
 * A heartbeat from the relay, every twenty seconds while its port is open.
 * Carries nothing; its arrival is the point. An MV3 service worker is evicted
 * after 30 s without an *event*, and a port that is merely open is not one —
 * only traffic on it resets the timer.
 */
export type RelayPing = { type: "relay-ping" };

/** From the options page right after pairing: poll now, do not wait a minute. */
export type PollRequest = { type: "poll" };

export type DiagnoseRequest = { type: "diagnose"; connectionId: string };

/** One line on the diagnostics screen. */
export type DiagnosisCheck = {
  id: string;
  label: string;
  /**
   * `warn` is "works, but not the way you probably expect"; `fail` is "this is
   * why nothing is happening"; `info` is a fact about how the product is built
   * or a state that passes on its own, and does **not** count toward the
   * summary — otherwise no healthy install can ever summarise as "working".
   */
  state: "ok" | "info" | "warn" | "fail";
  detail: string;
};

/**
 * What the worker reports for one connection. Split by direction: records up
 * and commands down are two channels that fail independently, and one number
 * for both would call a healthy upload with a dead command path "connected".
 */
export type Diagnosis = {
  checks: DiagnosisCheck[];
  up: {
    queued: number;
    dropped: number;
    acceptedLastPost: number;
    duplicatesLastPost: number;
    lastPostAt: number | null;
  };
  down: {
    commandsLastPost: number;
    /** False while the adapter's write path is unverified. */
    writeSupported: boolean;
  };
};
