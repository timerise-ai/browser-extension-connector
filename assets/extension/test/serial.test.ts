import { describe, expect, it } from "vitest";
import { Serial } from "../src/shared/serial";

/**
 * The one guarantee the queue and the loop both lean on: tasks handed to the
 * lane run one after another, in order, and one throwing does not take the
 * lane down with it.
 */
describe("Serial", () => {
  it("runs tasks strictly one after another, in order", async () => {
    const lane = new Serial();
    const log: string[] = [];
    const slow = lane.run(async () => {
      log.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      log.push("a:end");
      return "a";
    });
    const fast = lane.run(async () => {
      log.push("b");
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "a:end", "b"]);
  });

  it("keeps going after a task throws", async () => {
    const lane = new Serial();
    await expect(lane.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lane.run(async () => 42)).toBe(42);
  });

  it("reports what is running or waiting", async () => {
    const lane = new Serial();
    expect(lane.pending).toBe(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = lane.run(() => gate);
    const queued = lane.run(async () => undefined);
    expect(lane.pending).toBe(2);
    release();
    await Promise.all([held, queued]);
    expect(lane.pending).toBe(0);
  });
});
