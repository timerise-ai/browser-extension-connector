# Shipped tests

Every suite lives in `assets/extension/test/` and runs with vitest against the
sources in `assets/extension/src/`. Run them from the extension directory:

```bash
npx vitest run --dir test        # unit suites
node build.mjs && node package.mjs && npx vitest run --dir test   # + the two build-output suites
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.json --noUncheckedIndexedAccess
```

## What each suite pins

| Suite | Cases | The failure it exists for |
|---|---|---|
| `serial.test.ts` | 3 | tasks run in order; one throwing does not stop the lane |
| `context.test.ts` | 11 | orphaned-context wording, both directions; non-Errors never match |
| `queue.test.ts` | 18 | oldest-first; newest content wins; drops counted and cleared only once reported; ack by identity and version; overlapping push/ack loses nothing; failed write discards the cache; account tagging; batch size ≤ host cap |
| `routing.test.ts` | 11 | records go only to the pairing bound to their account; untagged → first; unbound pairing routes as the page shows; orphans only once everything is bound |
| `client.test.ts` | 10 | backoff escalates and caps, resets on success; 401 throws; foreign 200 is no answer; deadline handed to `fetch` |
| `ports.test.ts` | 3 | a live port survives another's disconnect; empty only when all gone |
| `engine.test.ts` | 7 | **commands from a progress-only response are run** and acked next post; acks ride the next post; acks survive a failed post; unknown kinds unacked; batch id stable across a retry; `queued` excludes the batch; `error` sent as `null` once reported |
| `content-script-format.test.ts` | 7 | built content scripts carry no top-level `import`/`export`; every manifest content script covered; tap defines injected |
| `package.test.ts` | 2 | zip read back through its central directory with `node:zlib` alone; every manifest-named file present; bytes match `dist/` |

## The regression tests for the fixes in provenance

```ts
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
```

```ts
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
```

## Writing tests for an adapter

Pin parsers against **redacted captured fixtures**, never hand-written JSON:
a shape that was captured is worth more than a wrapper that was guessed. For
every fixture, assert that every parsed record satisfies the host's wire
schema — the adapter must stay inside the wire's limits. Pin the empty-first-
page guard, the partial-pull behaviour and the write gate
([adapter-seam.md](adapter-seam.md)).
