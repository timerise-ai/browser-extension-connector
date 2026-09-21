import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncClient, UnauthorizedError } from "../src/background/client";
import type { Pairing } from "../src/background/config";

/**
 * The backoff curve, pinned because it was unreachable for a while: the loop
 * constructed a fresh `SyncClient` every tick, which reset the failure counter.
 * The client is now cached per connection in the engine; these guard the half
 * of that contract which lives here.
 */
const pairing: Pairing = {
  syncUrl: "https://host.example/api/connector/sync",
  token: "t".repeat(43),
  connectionId: "c1",
  provider: "stub",
  label: "Test",
  pairedAt: 0,
};

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/** `__AGENT_VERSION__` is injected by the build; tests run without it. */
(globalThis as Record<string, unknown>).__AGENT_VERSION__ ??= "test";

/** The least a real answer from the sync endpoint carries. */
const OK_BODY = JSON.stringify({
  accepted: 0,
  duplicates: 0,
  rejected: [],
  externalAccountId: null,
  enabled: true,
  commands: [],
  directives: { pollMs: 30_000, pull: null },
  serverTime: "2026-08-27T10:00:00.000Z",
});

function respond(status: number, body = status === 200 ? OK_BODY : "") {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

const batch = { batchId: "b1", records: [] };

describe("SyncClient backoff", () => {
  it("does not back off while healthy", async () => {
    respond(200);
    const c = new SyncClient(pairing);
    await c.post(batch);
    expect(c.backoffMs()).toBe(0);
  });

  it("escalates across consecutive failures", async () => {
    respond(500);
    const c = new SyncClient(pairing);
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await c.post(batch);
      seen.push(c.backoffMs());
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("caps, so recovery is never longer than a coffee", async () => {
    respond(500);
    const c = new SyncClient(pairing);
    for (let i = 0; i < 20; i += 1) await c.post(batch);
    expect(c.backoffMs()).toBeLessThanOrEqual(5 * 60_000);
  });

  it("forgets the failures as soon as one call succeeds", async () => {
    respond(500);
    const c = new SyncClient(pairing);
    await c.post(batch);
    await c.post(batch);
    expect(c.backoffMs()).toBeGreaterThan(0);
    respond(200);
    await c.post(batch);
    expect(c.backoffMs()).toBe(0);
  });

  it("throws on 401 rather than backing off", async () => {
    respond(401);
    const c = new SyncClient(pairing);
    await expect(c.post(batch)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(c.backoffMs()).toBe(0);
  });

  it("exposes its token so a re-pairing can be noticed", () => {
    expect(new SyncClient(pairing).token).toBe(pairing.token);
  });
});

describe("SyncClient response shape", () => {
  it("treats a 200 with a foreign body as no answer, and backs off", async () => {
    respond(200, "<html>captive portal</html>");
    const c = new SyncClient(pairing);
    expect(await c.post(batch)).toBeNull();
    expect(c.backoffMs()).toBeGreaterThan(0);
  });

  it("treats a JSON body missing the directives as no answer", async () => {
    respond(200, JSON.stringify({ ok: true }));
    expect(await new SyncClient(pairing).post(batch)).toBeNull();
  });

  it("defaults the fields the loop only reads optionally", async () => {
    respond(200, JSON.stringify({ enabled: false, directives: { pollMs: 60_000 } }));
    const res = await new SyncClient(pairing).post(batch);
    expect(res).toMatchObject({ enabled: false, accepted: 0, commands: [], rejected: [] });
    expect(res?.directives).toEqual({ pollMs: 60_000, pull: null });
  });

  it("hands fetch a deadline, and reads its firing as no answer", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const c = new SyncClient(pairing);
    expect(await c.post(batch)).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(c.backoffMs()).toBeGreaterThan(0);
  });
});
