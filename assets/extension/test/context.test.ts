import { describe, expect, it } from "vitest";
import { isContextInvalidated } from "../src/shared/context";

/**
 * Both directions matter. A false negative retries a dead extension context
 * once a second for the life of the tab. A false positive gives up on a
 * service worker that was merely restarting, and that failure is silent.
 */
describe("isContextInvalidated", () => {
  it.each([
    "Extension context invalidated.",
    "Extension context invalidated",
    "Uncaught Error: Extension context invalidated.",
    "The message port closed before a response was received.",
  ])("recognises %j as terminal", (message) => {
    expect(isContextInvalidated(new Error(message))).toBe(true);
  });

  it.each([
    "Could not establish connection. Receiving end does not exist.",
    "Failed to fetch",
    "network error",
  ])("treats %j as retryable", (message) => {
    expect(isContextInvalidated(new Error(message))).toBe(false);
  });

  it.each([["Extension context invalidated"], [null], [undefined], [{ message: "Extension context" }]])(
    "ignores non-Error %j rather than guessing",
    (value) => {
      expect(isContextInvalidated(value)).toBe(false);
    },
  );
});
