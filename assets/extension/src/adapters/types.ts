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
