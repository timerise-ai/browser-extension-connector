import { describe, expect, it, vi } from "vitest";
import type { Ack, Command, SyncResponse } from "../src/wire";
import type { ConnectorAdapter } from "../src/adapters/types";
import type { SyncClient, SyncPayload } from "../src/background/client";
import type { LastPost, Pairing } from "../src/background/config";
import { Engine, type EngineDeps } from "../src/background/engine";
import { RecordQueue } from "../src/background/queue";
import { memoryStore } from "./helpers";

const pairing: Pairing = {
  syncUrl: "https://host.example/api/connector/sync",
  token: "tok",
  connectionId: "c1",
  provider: "test",
  label: "Test",
  pairedAt: 0,
  accountId: "acct-1",
};

function response(over: Partial<SyncResponse> = {}): SyncResponse {
  return {
    accepted: 0,
    duplicates: 0,
    rejected: [],
    externalAccountId: "acct-1",
    enabled: true,
    commands: [],
    directives: { pollMs: 30_000, pull: null },
    serverTime: "",
    ...over,
  };
}

/** A scripted host: each call to `post` returns the next answer; `null` means "no answer". */
function scriptedClient(answers: (SyncResponse | null)[]) {
  const posts: SyncPayload[] = [];
  const client = {
    token: pairing.token,
    backoffMs: () => 1_000,
    post: vi.fn(async (payload: SyncPayload) => {
      posts.push(payload);
      return answers.shift() ?? null;
    }),
  } as unknown as SyncClient;
  return { client, posts };
}

function harness(adapter: Partial<ConnectorAdapter>, answers: (SyncResponse | null)[]) {
  const store = memoryStore();
  const queue = new RecordQueue(store);
  const { client, posts } = scriptedClient(answers);
  const lastPosts: Record<string, LastPost> = {};
  const deps: EngineDeps = {
    queue,
    store,
    adapters: [
      {
        id: "test",
        hostPatterns: [/^https:\/\/service\.example\//],
        serviceHome: "https://service.example/",
        writeVerified: true,
        parse: () => [],
        accountId: () => null,
        ...adapter,
      },
    ],
    loadPairings: async () => [pairing],
    bindPairing: async () => undefined,
    recordLastPost: async (id, outcome) => {
      lastPosts[id] = outcome;
    },
    loadLastPosts: async () => lastPosts,
    http: async () => ({ ok: true, status: 200, body: null }),
    relayStatus: async () => null,
    onPollMs: () => undefined,
    makeClient: () => client,
    now: () => 1_000,
  };
  return { engine: new Engine(deps, 30_000), posts, queue };
}

const command = (id: string): Command => ({ id, kind: "do-thing", payload: {}, externalRef: null });

describe("Engine: every response is handled", () => {
  /**
   * The host claims commands under a lease on *every* post. The pull-progress
   * post used to discard its response, so a command handed out there burned
   * a lease and an attempt without running — and after enough misses was
   * marked failed having never executed.
   */
  it("runs commands handed out on the pull-progress post", async () => {
    const executed: string[] = [];
    const { engine, posts } = harness(
      {
        pull: async () => ({ records: [], cursor: null }),
        execute: async (c): Promise<Ack> => {
          executed.push(c.id);
          return { id: c.id, ok: true };
        },
      },
      [
        response({ directives: { pollMs: 30_000, pull: { kind: "archive", cursor: null, pageSize: 20 } } }),
        response({ commands: [command("cmd-from-progress")] }),
        response(),
      ],
    );
    await engine.tick();
    expect(executed).toEqual(["cmd-from-progress"]);
    // ...and its ack rides the next post.
    await engine.tick();
    expect(posts[2]?.ack).toEqual([{ id: "cmd-from-progress", ok: true }]);
  });

  it("acknowledges commands on the next post, never the same one", async () => {
    const { engine, posts } = harness(
      { execute: async (c): Promise<Ack> => ({ id: c.id, ok: true, externalRef: "ext-9" }) },
      [response({ commands: [command("cmd-1")] }), response()],
    );
    await engine.tick();
    expect(posts[0]?.ack).toEqual([]);
    await engine.tick();
    expect(posts[1]?.ack).toEqual([{ id: "cmd-1", ok: true, externalRef: "ext-9" }]);
  });

  it("puts acks back when the post carrying them gets no answer", async () => {
    const { engine, posts } = harness(
      { execute: async (c): Promise<Ack> => ({ id: c.id, ok: true }) },
      [response({ commands: [command("cmd-1")] }), null, response()],
    );
    await engine.tick();
    await engine.tick(); // no answer: the ack must survive
    engine.notBefore.clear();
    await engine.tick();
    expect(posts[2]?.ack).toEqual([{ id: "cmd-1", ok: true }]);
  });

  it("leaves a command kind this build cannot run unacknowledged", async () => {
    const { engine, posts } = harness({}, [response({ commands: [command("cmd-1")] }), response()]);
    await engine.tick();
    await engine.tick();
    expect(posts[1]?.ack).toEqual([]);
  });
});

describe("Engine: batch identity", () => {
  /** A retried post must carry the same id as the attempt the host may have logged. */
  it("re-uses the batch id while the same records are still waiting", async () => {
    const { engine, posts, queue } = harness({}, [null, null, response()]);
    await queue.push([{ kind: "item", externalId: "1", payload: {} }]);
    await engine.tick();
    engine.notBefore.clear();
    await engine.tick();
    expect(posts[0]?.batchId).toBe(posts[1]?.batchId);

    engine.notBefore.clear();
    await engine.tick(); // accepted: the batch is gone
    await queue.push([{ kind: "item", externalId: "2", payload: {} }]);
    await engine.tick();
    expect(posts[3]?.batchId).not.toBe(posts[0]?.batchId);
  });

  it("reports what will still be waiting after the post, not the batch itself", async () => {
    const { engine, posts, queue } = harness({}, [response()]);
    await queue.push([{ kind: "item", externalId: "1", payload: {} }]);
    await engine.tick();
    expect(posts[0]?.queued).toBe(0);
    expect(posts[0]?.records).toHaveLength(1);
  });

  it("sends the error as null once it has been reported, so the host clears it", async () => {
    const { engine, posts } = harness({}, [response(), response()]);
    engine.noteError("c1", "something broke");
    await engine.tick();
    await engine.tick();
    expect(posts[0]?.error).toBe("something broke");
    expect(posts[1]?.error).toBeNull();
  });
});
