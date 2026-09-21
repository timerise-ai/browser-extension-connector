import { describe, expect, it } from "vitest";
import { PortRegistry } from "../src/background/ports";

/**
 * Two service tabs, then the newer one closes. With a single "current port"
 * slot the worker was left with `null` while the older tab was alive, and
 * every pull failed "no service tab" until a tab was reopened.
 */
describe("PortRegistry", () => {
  const port = (name: string) => ({ name, postMessage: () => undefined });

  it("keeps a live port after another one disconnects", () => {
    const ports = new PortRegistry<ReturnType<typeof port>>();
    const first = port("first");
    const second = port("second");
    ports.add(first);
    ports.add(second);
    ports.remove(second);
    expect(ports.any()).toBe(first);
    expect(ports.size).toBe(1);
  });

  it("is empty only when every port is gone", () => {
    const ports = new PortRegistry<ReturnType<typeof port>>();
    const only = port("only");
    ports.add(only);
    ports.remove(only);
    expect(ports.any()).toBeNull();
    expect(ports.size).toBe(0);
  });

  it("prefers the longest-lived tab", () => {
    const ports = new PortRegistry<ReturnType<typeof port>>();
    const first = port("first");
    ports.add(first);
    ports.add(port("second"));
    expect(ports.any()).toBe(first);
  });
});
