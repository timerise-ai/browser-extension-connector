import { describe, expect, it } from "vitest";
import { PortRegistry, relayAnswer } from "../src/background/ports";

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

/**
 * A relay refusal once resolved as `{ ok: false, status: 0 }`, so "no session
 * seen" reached the adapter, and then the host, as a bare status 0.
 */
describe("relayAnswer", () => {
  it("throws a refusal with the relay's own reason", () => {
    expect(() =>
      relayAnswer({ type: "relay-fetch-result", id: "r1", ok: false, status: 0, body: null, error: "No session seen" }),
    ).toThrow("No session seen");
  });

  it("hands an HTTP answer through, a failing status included", () => {
    expect(relayAnswer({ type: "relay-fetch-result", id: "r2", ok: false, status: 404, body: { e: 1 } })).toEqual({
      ok: false,
      status: 404,
      body: { e: 1 },
    });
  });
});
