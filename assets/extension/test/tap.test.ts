import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The MAIN-world tap, built as the build builds it and run against a stand-in
 * page. The cookie-authenticated variant (an empty header allowlist) once posted
 * no session at all, so the relay refused every pull as "no session seen".
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ORIGIN = "https://service.example";

async function page(headers: string[], answer: () => Response) {
  const bundled = await build({
    entryPoints: [join(root, "src/inject/net-tap.ts")],
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
    define: { __TAP_CAPTURE__: JSON.stringify("/api/"), __TAP_AUTH_HEADERS__: JSON.stringify(headers) },
  });
  const posted: { source: string; origin?: string; headers?: Record<string, string> }[] = [];
  const window = {
    location: { href: `${ORIGIN}/app`, origin: ORIGIN },
    postMessage: (message: (typeof posted)[number]) => posted.push(message),
    fetch: async (_url: string, _init?: RequestInit) => answer(),
  };
  const XMLHttpRequest = function XMLHttpRequest() {};
  XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {} };
  vm.runInContext(bundled.outputFiles[0]!.text, vm.createContext({ window, XMLHttpRequest, Headers, URL }));
  return {
    posted,
    async request(init?: RequestInit) {
      await window.fetch(`${ORIGIN}/api/orders`, init);
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

const json = () => new Response('{"orders":[]}', { status: 200 });
const auths = (posted: { source: string }[]) => posted.filter((m) => m.source === "connector-auth");

describe("net-tap session signal", () => {
  it("posts only the allowlisted header the page sent", async () => {
    const tab = await page(["authorization"], json);
    await tab.request({ headers: { authorization: "Bearer t", "x-trace": "1" } });
    expect(auths(tab.posted)).toEqual([{ source: "connector-auth", origin: ORIGIN, headers: { authorization: "Bearer t" } }]);
  });

  it("with an empty allowlist, posts the origin with no headers once a captured JSON answer succeeds", async () => {
    const tab = await page([], json);
    await tab.request();
    await tab.request();
    expect(auths(tab.posted)).toEqual([{ source: "connector-auth", origin: ORIGIN, headers: {} }]);
  });

  it("with an empty allowlist, a login page is no session", async () => {
    const tab = await page([], () => new Response("<html>Sign in</html>", { status: 200 }));
    await tab.request();
    expect(auths(tab.posted)).toEqual([]);
  });
});
