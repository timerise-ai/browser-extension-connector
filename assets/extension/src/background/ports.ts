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

  /** Any live port, or `null`. Insertion order — the longest-lived tab first. */
  any(): P | null {
    for (const p of this.ports) return p;
    return null;
  }

  get size(): number {
    return this.ports.size;
  }
}
