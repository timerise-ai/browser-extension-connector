import type { RelayFetchResult } from "../shared/messages";

/**
 * Every live relay port, so a request can go to *any* open service tab.
 *
 * A single "current port" slot is the natural first design and it fails the
 * moment a user opens the service in two tabs: the second replaces the first,
 * and when the second closes the slot is null while the first is still alive.
 * Every pull and command then fails "no service tab" until a tab is (re)opened,
 * and the loop drops to its slow cadence. Pure, so the rule is testable.
 */
export class PortRegistry<P extends { postMessage(message: unknown): void }> {
  private readonly ports = new Set<P>();

  add(port: P): void {
    this.ports.add(port);
  }

  remove(port: P): void {
    this.ports.delete(port);
  }

  /** Any live port, or `null`. Insertion order: the longest-lived tab first. */
  any(): P | null {
    for (const p of this.ports) return p;
    return null;
  }

  get size(): number {
    return this.ports.size;
  }
}

/**
 * What a relay answer resolves to. A refusal (no session seen, another origin,
 * the tab closed) is a transport failure, not an HTTP answer: it throws, as a
 * missing service tab does, so its reason reaches the host's `error` instead of
 * reaching the adapter as a bare status 0.
 */
export function relayAnswer(result: RelayFetchResult): { ok: boolean; status: number; body: unknown } {
  if (result.error) throw new Error(result.error);
  return { ok: result.ok, status: result.status, body: result.body };
}
