/**
 * MAIN-world network tap.
 *
 * This file runs **inside the service's own page context**, which is the
 * entire reason it exists: a content script in the isolated world gets its own
 * `fetch` and its own `XMLHttpRequest`, so it cannot see a single response the
 * page receives. Only MAIN-world code can, declared with
 * `content_scripts[].world: "MAIN"`.
 *
 * Two constraints follow, and both look like style until they bite:
 *
 * 1. **No `chrome.*` here.** MAIN-world code has no extension APIs. A stray
 *    `chrome.runtime.sendMessage` throws on the page and takes the tap down
 *    silently. Everything leaves through `window.postMessage` to the relay.
 * 2. **No import from the rest of the extension.** The build keeps this bundle
 *    separate; its two inputs arrive as build-time defines from the adapter.
 *
 * It **observes**; it does not crawl. Whatever the user opens is captured as a
 * side effect of them working, which keeps the traffic profile identical to a
 * person at a desk.
 *
 * It also captures request headers, because many services authenticate their
 * own API with headers rather than cookies — a request the extension issues
 * itself cannot lean on the browser attaching anything. The tap records the
 * headers the page *already sent* and hands them to the relay, which replays
 * them. Rules that keep a live credential in extension memory honest, enforced
 * here and in the relay: read only from requests the page itself made,
 * replayed only to the origin it came from, never persisted, never sent to
 * the host (the sync payload is a fixed field set with nowhere to put one).
 */

/**
 * The two `window.postMessage` channels out of here. `content/relay.ts`
 * declares these literals a second time rather than importing them: an import
 * would pull this module into the isolated-world bundle, install a second set
 * of patches there, and feed the relay's own requests back to itself.
 *
 * Not `export`ed, and that is load-bearing: a content script is a classic
 * script, and one top-level `export` in the bundle is a `SyntaxError` that
 * runs none of the file and logs nowhere anyone looks. It shipped dead once.
 */
const TAP_MESSAGE = "connector-tap";
const AUTH_MESSAGE = "connector-auth";

/** Only these ever leave the page. Anything else is not even inspected. */
const CAPTURE = new RegExp(__TAP_CAPTURE__, "i");
/** Explicit allowlist, not "whatever the page sent" — see the adapter. */
const AUTH_HEADERS: string[] = __TAP_AUTH_HEADERS__;
/** UTF-16 units, not bytes — a cheap ceiling, not a precise one. */
const MAX_BODY_CHARS = 512 * 1024;

function emit(url: string, status: number, method: string, body: string): void {
  if (body.length > MAX_BODY_CHARS) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return; // not JSON: not ours
  }
  window.postMessage({ source: TAP_MESSAGE, url, status, method, body: parsed }, window.location.origin);
}

/**
 * Post the auth headers once per change, not on every request. The
 * fingerprint uses the primary header's LENGTH rather than its value: it only
 * has to notice a rotation, and a value that never needs comparing never
 * needs keeping.
 */
let lastAuthFingerprint = "";
function emitAuth(origin: string, headers: Record<string, string>): void {
  const names = Object.keys(headers).sort().join(",");
  const primary = AUTH_HEADERS[0] ?? "";
  const fingerprint = `${origin}|${names}|${(headers[primary] ?? "").length}`;
  if (fingerprint === lastAuthFingerprint) return;
  lastAuthFingerprint = fingerprint;
  window.postMessage({ source: AUTH_MESSAGE, origin, headers }, window.location.origin);
}

function collectAuth(url: string, get: (name: string) => string | null): void {
  try {
    const origin = new URL(url, window.location.href).origin;
    const headers: Record<string, string> = {};
    for (const name of AUTH_HEADERS) {
      const value = get(name);
      if (value) headers[name] = value;
    }
    if (Object.keys(headers).length > 0) emitAuth(origin, headers);
  } catch {
    /* never break the page */
  }
}

function installFetchTap(): void {
  const original = window.fetch;
  window.fetch = async function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    const response = await original.apply(this as typeof globalThis, args);
    try {
      // `fetch` takes a URL or a Request, and either may carry headers and
      // method — read both from whichever supplied them.
      const [input, init] = args;
      const request = typeof input === "string" || input instanceof URL ? null : input;
      const url = request ? request.url : String(input);
      if (CAPTURE.test(url)) {
        const headers = new Headers(init?.headers ?? request?.headers ?? {});
        collectAuth(url, (name) => headers.get(name));
        if (response.ok) {
          const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
          // `clone()` is mandatory: reading the original body would consume
          // it and the page would render blank.
          response
            .clone()
            .text()
            .then((text) => emit(url, response.status, method, text))
            .catch(() => {});
        }
      }
    } catch {
      // A tap that throws must never break the page it is watching.
    }
    return response;
  } as typeof fetch;
}

function installXhrTap(): void {
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const meta = new WeakMap<XMLHttpRequest, { url: string; method: string; headers: Record<string, string> }>();

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: [boolean?, (string | null)?, (string | null)?]
  ): void {
    meta.set(this, { url: String(url), method: method.toUpperCase(), headers: {} });
    open.call(this, method, url, ...(rest as [boolean, string | null, string | null]));
  } as typeof XMLHttpRequest.prototype.open;

  // Many SPAs use XHR for their API calls, so this — not the fetch tap — is
  // often where the auth headers are actually seen.
  XMLHttpRequest.prototype.setRequestHeader = function patchedSet(this: XMLHttpRequest, name: string, value: string): void {
    const m = meta.get(this);
    if (m) m.headers[String(name).toLowerCase()] = String(value);
    setRequestHeader.call(this, name, value);
  } as typeof XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    try {
      const m = meta.get(this);
      if (m && CAPTURE.test(m.url)) collectAuth(m.url, (n) => m.headers[n] ?? null);
    } catch {
      /* never break the page */
    }
    this.addEventListener("load", () => {
      try {
        const m = meta.get(this);
        if (!m || !CAPTURE.test(m.url) || this.status < 200 || this.status >= 300) return;
        // Reading `responseText` on a non-text `responseType` throws — and a
        // throw in a load handler is invisible, so guard rather than catch.
        if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
        const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
        emit(m.url, this.status, m.method, text);
      } catch {
        /* never break the page */
      }
    });
    send.call(this, body);
  } as typeof XMLHttpRequest.prototype.send;
}

installFetchTap();
installXhrTap();
