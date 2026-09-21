import { describe, expect, it } from "vitest";
import { accepts, accountFor, orphaned } from "../src/background/routing";

const A = { connectionId: "conn-a", accountId: "100" };
const B = { connectionId: "conn-b", accountId: "200" };
const UNBOUND = { connectionId: "conn-new", accountId: null };

describe("accountFor", () => {
  it("is the host's binding when there is one", () => {
    expect(accountFor(A, "999")).toBe("100");
  });
  it("falls back to what the page shows for a pairing not yet bound", () => {
    expect(accountFor(UNBOUND, "999")).toBe("999");
    expect(accountFor(UNBOUND, null)).toBeNull();
  });
});

describe("accepts", () => {
  it("routes a tagged record to the pairing bound to its account", () => {
    const pairings = [A, B];
    expect(accepts(A, { accountId: "100" }, pairings, null)).toBe(true);
    expect(accepts(B, { accountId: "100" }, pairings, null)).toBe(false);
    expect(accepts(B, { accountId: "200" }, pairings, null)).toBe(true);
  });
  it("gives an untagged record to the first pairing only", () => {
    const pairings = [A, B];
    expect(accepts(A, {}, pairings, null)).toBe(true);
    expect(accepts(B, {}, pairings, null)).toBe(false);
    expect(accepts(A, { accountId: null }, pairings, null)).toBe(true);
  });
  it("lets an unbound pairing carry what the page currently shows", () => {
    const pairings = [A, UNBOUND];
    expect(accepts(UNBOUND, { accountId: "200" }, pairings, "200")).toBe(true);
    expect(accepts(UNBOUND, { accountId: "100" }, pairings, "200")).toBe(false);
  });
  it("keeps another account's records away from a bound pairing", () => {
    expect(accepts(A, { accountId: "200" }, [A], "200")).toBe(false);
  });
});

describe("orphaned", () => {
  it("names a record no bound pairing will ever carry", () => {
    expect(orphaned({ accountId: "300" }, [A, B], null)).toBe(true);
    expect(orphaned({ accountId: "200" }, [A, B], null)).toBe(false);
  });
  it("never orphans an untagged record", () => {
    expect(orphaned({}, [A, B], null)).toBe(false);
    expect(orphaned({ accountId: null }, [A, B], null)).toBe(false);
  });
  it("waits while any pairing is still unbound", () => {
    expect(orphaned({ accountId: "300" }, [A, UNBOUND], "100")).toBe(false);
  });
  it("orphans nothing when there are no pairings at all", () => {
    expect(orphaned({ accountId: "300" }, [], null)).toBe(false);
  });
});
