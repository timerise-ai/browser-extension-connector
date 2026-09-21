/**
 * A one-lane queue for async work.
 *
 * `chrome.storage.local` has no transactions, so every "read, change, write
 * back" races every other one, and the tap fires several at once each time
 * the page loads a screen, while the sync loop is acknowledging a batch. Two
 * overlapping read-modify-writes keep whichever finished last and silently
 * lose the other's records. For a tapped record that is a delay (it is
 * re-observed); for a pulled page it is a hole, because the cursor advances
 * regardless.
 *
 * Kept alone and pure so both the queue and the loop can use it, and so the
 * ordering guarantee can be tested without a browser.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Runs `task` after everything queued before it, and returns its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const next = this.tail.then(task, task).finally(() => {
      this.depth -= 1;
    });
    // The chain must never reject, or every later task would be skipped.
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** How many tasks are running or waiting. Zero means idle. */
  get pending(): number {
    return this.depth;
  }
}
