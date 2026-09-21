import type { SyncRequest, SyncResponse } from "../wire";
import type { Pairing } from "./config";

/**
 * The HTTP client for the host app. One request type; `server-contract.md`
 * is the other end.
 *
 * Carries its own backoff rather than leaning on the host's `pollMs`: a host
 * that is down cannot tell us to slow down, and every install hammering a
 * failing deploy every 30 s is how a small outage becomes a large one.
 */

/** Everything but `token` and `agentVersion`, which the client adds. */
export type SyncPayload = Omit<SyncRequest, "token" | "agentVersion">;

export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";
}

/**
 * How long one post may take before it is given up on. Without a ceiling a
 * request that never completes (a proxy that swallows the connection, a
 * laptop that slept mid-POST) held the loop's in-flight guard until Chrome
 * happened to evict the worker.
 */
const REQUEST_TIMEOUT_MS = 25_000;

export class SyncClient {
  private failures = 0;

  constructor(private readonly pairing: Pairing) {}

  /** Read by the loop to notice a re-pairing: a cached client would keep posting a revoked token. */
  get token(): string {
    return this.pairing.token;
  }

  /** Milliseconds to wait after a failure. Capped, so recovery is never longer than a coffee. */
  backoffMs(): number {
    return this.failures === 0 ? 0 : Math.min(5 * 60_000, 2 ** Math.min(this.failures, 6) * 1_000);
  }

  async post(payload: SyncPayload): Promise<SyncResponse | null> {
    try {
      const res = await fetch(this.pairing.syncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No cookies to the host: the token is the credential, and sending
        // ambient credentials to a host the user typed would leak a session
        // into a third party if that host were wrong.
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ token: this.pairing.token, agentVersion: __AGENT_VERSION__, ...payload }),
      });

      if (res.status === 401) {
        // Revoked, unpaired, or the host rotated its pepper. Stop; the options
        // page is where a human re-pairs. Retrying a 401 forever is how an
        // extension ends up in a log nobody reads.
        this.failures = 0;
        throw new UnauthorizedError();
      }
      if (!res.ok) {
        this.failures += 1;
        return null;
      }
      const body = asSyncResponse(await res.json());
      if (!body) {
        // A 200 that is not ours: a captive portal, a CDN error page with the
        // wrong status, a proxy answering for a dead deploy.
        this.failures += 1;
        return null;
      }
      this.failures = 0;
      return body;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      this.failures += 1;
      return null;
    }
  }
}

/**
 * The response, if it has the shape the loop is about to read from it. Only
 * the fields the loop dereferences without a guard are checked; the rest are
 * defaulted so a host one field ahead of this build still parses.
 */
export function asSyncResponse(value: unknown): SyncResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const directives = v.directives;
  if (typeof directives !== "object" || directives === null) return null;
  const d = directives as Record<string, unknown>;
  const pollMs = d.pollMs;
  if (typeof pollMs !== "number" || !Number.isFinite(pollMs) || pollMs < 1_000) return null;
  if (typeof v.enabled !== "boolean") return null;
  const pull = d.pull;
  return {
    accepted: typeof v.accepted === "number" ? v.accepted : 0,
    duplicates: typeof v.duplicates === "number" ? v.duplicates : 0,
    rejected: Array.isArray(v.rejected) ? (v.rejected as SyncResponse["rejected"]) : [],
    externalAccountId: typeof v.externalAccountId === "string" ? v.externalAccountId : null,
    enabled: v.enabled,
    commands: Array.isArray(v.commands) ? (v.commands as SyncResponse["commands"]) : [],
    directives: {
      pollMs,
      pull: typeof pull === "object" && pull !== null ? (pull as NonNullable<SyncResponse["directives"]["pull"]>) : null,
    },
    serverTime: typeof v.serverTime === "string" ? v.serverTime : "",
  };
}
