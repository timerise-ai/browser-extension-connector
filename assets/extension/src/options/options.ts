import { loadPairings, removePairing, savePairing } from "../background/config";
import type { Diagnosis, DiagnosisCheck } from "../shared/messages";
import { t } from "../shared/strings";

/**
 * The pairing screen.
 *
 * Two steps, matching the endpoint: the PIN alone lists the tenant's
 * connections (no credential is issued), then choosing one mints the token.
 * That split lets a wrong PIN be told apart from a wrong choice without the
 * host ever revealing which.
 *
 * The host's address is typed here, once, and the origin permission is
 * requested for **that one host** — which is why the manifest asks for no
 * host origin up front. A listing that requested every site would be both a
 * review problem and untrue.
 */

/** The adapter this build pairs for. One adapter per build keeps the listing's single purpose honest. */
const PROVIDER = "stub";
/** Path on the host; the host may rename it — the sync URL comes back absolute anyway. */
const PAIR_PATH = "/api/connector/pair";

type Connection = { id: string; label: string; paired: boolean };

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Built rather than templated, so a host-supplied name can never be markup. */
function say(text: string, tone: "ok" | "err"): void {
  const box = document.createElement("div");
  box.className = `msg ${tone}`;
  box.textContent = text;
  $("message").replaceChildren(box);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeHost(raw: string): string | null {
  const typed = raw.trim();
  if (!typed) return null;
  try {
    // A bare `localhost:3000` is a developer's host, which has no TLS; a bare
    // hostname anywhere else is a real one, which does.
    const scheme = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(typed) ? "http" : "https";
    const url = new URL(/^https?:\/\//i.test(typed) ? typed : `${scheme}://${typed}`);
    // Path, query and hash are discarded: the endpoint is fixed, and honouring
    // a pasted deep link would send the PIN somewhere unintended.
    return url.origin;
  } catch {
    return null;
  }
}

/** The one endpoint this page talks to. Never with ambient credentials. */
function postPair(origin: string, body: { pin: string; connectionId?: string }): Promise<Response> {
  return fetch(`${origin}${PAIR_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(body),
  });
}

/** The host's own words for a failed response, when the body is ours. */
async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 5xx is called out separately because it is the one class of failure the
 * person at the keyboard can do nothing about: without saying so, a plain
 * "failed" invites a fourth attempt with the same correct PIN.
 */
async function failure(res: Response, fallback: string): Promise<string> {
  const detail = (await serverMessage(res)) ?? fallback;
  if (res.status >= 500) return t("serverFault", { detail, status: res.status });
  return `${detail} (${res.status})`;
}

function networkMessage(err: unknown, origin: string): string {
  const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
  return t("networkFailed", { origin, detail });
}

function dot(state: "ok" | "info" | "warn" | "fail" | "idle"): HTMLElement {
  return el("span", `dot ${state}`);
}

/** The worst state present. Nine green checks and one red one is "not working". */
function overall(checks: DiagnosisCheck[]): "ok" | "warn" | "fail" {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "warn")) return "warn";
  // `info` deliberately does not count: it marks how the product is built.
  return "ok";
}

const SUMMARY = { ok: t("summaryOk"), warn: t("summaryWarn"), fail: t("summaryFail") } as const;

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleTimeString() : "—";
}

/** The two directions, side by side and separately labelled: they fail independently. */
function renderWays(report: Diagnosis): HTMLElement {
  const box = el("div", "ways");
  const up = el("div", "way");
  up.append(el("h3", "", t("upHeading")));
  const upList = document.createElement("dl");
  for (const [term, value] of [
    [t("acceptedLast"), String(report.up.acceptedLastPost)],
    [t("duplicates"), String(report.up.duplicatesLastPost)],
    [t("queued"), String(report.up.queued)],
    [t("dropped"), String(report.up.dropped)],
    [t("lastContact"), when(report.up.lastPostAt)],
  ]) {
    upList.append(el("dt", "", term), el("dd", "", value));
  }
  up.append(upList);

  const down = el("div", "way");
  down.append(el("h3", "", t("downHeading")));
  const downList = document.createElement("dl");
  downList.append(el("dt", "", t("commandsLast")), el("dd", "", String(report.down.commandsLastPost)));
  downList.append(el("dt", "", t("writeState")), el("dd", "", report.down.writeSupported ? t("writeActive") : t("writeDisabled")));
  down.append(downList);
  box.append(up, down);
  return box;
}

function renderReport(report: Diagnosis): HTMLElement {
  const box = el("div", "report");
  for (const check of report.checks) {
    const row = el("div", "check");
    row.append(dot(check.state), el("span", "check-label", check.label), el("span", "check-detail", check.detail));
    box.append(row);
  }
  box.append(renderWays(report));
  return box;
}

async function runDiagnosis(connectionId: string, into: HTMLElement, state: HTMLElement): Promise<void> {
  into.replaceChildren(el("p", "hint", t("checking")));
  const reply = (await chrome.runtime.sendMessage({ type: "diagnose", connectionId })) as
    | { ok: true; report: Diagnosis }
    | { ok: false; error: string }
    | undefined;
  // No reply at all means the worker did not come up — itself a diagnosis.
  if (!reply) return into.replaceChildren(el("p", "check-detail", t("noReply")));
  if (!reply.ok) return into.replaceChildren(el("p", "check-detail", t("testFailed", { error: reply.error })));
  const worst = overall(reply.report.checks);
  state.replaceChildren(dot(worst), el("span", "state", SUMMARY[worst]));
  into.replaceChildren(renderReport(reply.report));
}

async function renderPairings(): Promise<void> {
  const list = await loadPairings();
  const ul = $("pairings");
  ul.replaceChildren();
  $("empty").style.display = list.length ? "none" : "block";

  for (const pairing of list) {
    const li = document.createElement("li");
    const row = el("div", "row");
    const identity = el("div", "grow");
    // The binding is shown because it is the one thing a two-account setup
    // has to get right and cannot otherwise see from here.
    identity.append(
      el("div", "name", pairing.label),
      el("div", "where", `${new URL(pairing.syncUrl).origin}${pairing.accountId ? ` · ${pairing.accountId}` : ""}`),
    );
    // Idle until tested, and it says so: a green dot on open is a claim the
    // extension has not checked.
    const state = el("div", "row");
    state.append(dot("idle"), el("span", "state", t("notChecked")));
    const report = el("div", "report");

    const actions = el("div", "actions");
    const test = document.createElement("button");
    test.textContent = t("testConnection");
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        await runDiagnosis(pairing.connectionId, report, state);
      } finally {
        test.disabled = false;
      }
    });

    // Two presses: undoing this means the host's UI and the whole pairing
    // flow again, which is a lot to pay for a slip of the mouse.
    const unpair = document.createElement("button");
    unpair.textContent = t("unpair");
    let armed = false;
    unpair.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        unpair.textContent = t("unpairConfirm");
        setTimeout(() => {
          armed = false;
          unpair.textContent = t("unpair");
        }, 4_000);
        return;
      }
      await removePairing(pairing.connectionId);
      // Local only: the host's "disconnect" revokes the token. Said plainly —
      // a half-revoked pairing that still syncs is worse than one that visibly does not.
      await renderPairings();
      say(t("unpairedLocally"), "ok");
    });

    actions.append(test, unpair);
    row.append(identity, state, actions);
    li.append(row, report);
    ul.append(li);
  }
}

async function fetchConnections(): Promise<void> {
  const origin = normalizeHost($<HTMLInputElement>("host").value);
  const pin = $<HTMLInputElement>("pin").value.trim();
  $("choices").replaceChildren();
  if (!origin) return say(t("invalidHost"), "err");
  if (!/^\d{4,8}$/.test(pin)) return say(t("invalidPin"), "err");

  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return say(t("permissionDenied"), "err");

  try {
    const res = await postPair(origin, { pin });
    // 401 is answered in the extension's own words: the host deliberately
    // says the same thing for a wrong PIN and for a tenant with no PIN set.
    if (!res.ok) return say(res.status === 401 ? t("wrongPin") : await failure(res, t("listFailed")), "err");
    const body = (await res.json()) as { tenantName: string; connections: Connection[] };
    if (body.connections.length === 0) return say(t("noConnections"), "err");
    renderChoices(origin, pin, body.connections);
    say(t("chooseConnection", { name: body.tenantName }), "ok");
  } catch (err) {
    say(networkMessage(err, origin), "err");
  }
}

function renderChoices(origin: string, pin: string, connections: Connection[]): void {
  const box = $("choices");
  for (const conn of connections) {
    const button = document.createElement("button");
    button.textContent = conn.paired ? `${conn.label} ${t("rePair")}` : conn.label;
    button.addEventListener("click", () => void claim(origin, pin, conn));
    box.append(button, document.createTextNode(" "));
  }
}

async function claim(origin: string, pin: string, conn: Connection): Promise<void> {
  try {
    const res = await postPair(origin, { pin, connectionId: conn.id });
    if (!res.ok) return say(await failure(res, t("pairFailed")), "err");
    const body = (await res.json()) as { token: string; connectionId: string; syncUrl: string };
    await savePairing({
      syncUrl: body.syncUrl,
      token: body.token,
      connectionId: body.connectionId,
      provider: PROVIDER,
      label: conn.label,
      pairedAt: Date.now(),
    });
    $("choices").replaceChildren();
    $<HTMLInputElement>("pin").value = "";
    await renderPairings();
    say(t("paired", { label: conn.label }), "ok");
    // Poll now rather than at the next alarm: somebody is watching the host
    // for the badge. Best-effort — a worker mid-restart polls on its way up.
    try {
      await chrome.runtime.sendMessage({ type: "poll" });
    } catch {
      /* the next tick covers it */
    }
  } catch (err) {
    say(networkMessage(err, origin), "err");
  }
}

$("fetch").addEventListener("click", () => void fetchConnections());
// Enter in either field is the same gesture as the button — the PIN is read
// off another screen, and reaching for the mouse loses the digits.
for (const id of ["host", "pin"]) {
  $(id).addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void fetchConnections();
    }
  });
}
void renderPairings();
