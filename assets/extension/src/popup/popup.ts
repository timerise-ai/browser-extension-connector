import { ADAPTERS } from "../adapters";
import { loadLastPosts, loadPairings, type LastPost } from "../background/config";
import { DEFAULT_POLL_MS } from "../background/constants";
import { t } from "../shared/strings";

/**
 * The toolbar popup: the extension's front door.
 *
 * Deliberately read-only. Everything that changes state lives one click away
 * in the options page, because a popup closes the moment focus moves and a
 * half-finished pairing in a window that vanishes is worse than no shortcut.
 *
 * It reads storage directly rather than asking the service worker. Waking the
 * worker to render a popup would make opening the popup the thing that keeps
 * the worker alive, and a status that is only true because you are looking at
 * it is not a status. The numbers here are what the last real poll wrote.
 */

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Missing this many polls is a blip; more is worth a colour. Mirror it in the host. */
const STALE_AFTER_MS = 6 * DEFAULT_POLL_MS;

type Health = { state: "ok" | "warn" | "fail" | "idle"; note: string };

/**
 * What one connection is doing, from the last post alone. "Paused in the
 * host" outranks staleness: a connection that was switched off is doing
 * exactly what it was told, and calling that a fault teaches people to
 * ignore the colour.
 */
export function health(last: LastPost | undefined, now = Date.now()): Health {
  if (!last) return { state: "idle", note: t("neverPosted") };
  if (!last.ok) return { state: "fail", note: last.note ?? t("lastFailed") };
  if (!last.enabled) return { state: "warn", note: t("pausedInHost") };
  if (now - last.at > STALE_AFTER_MS) return { state: "warn", note: t("stale") };
  if (last.pulling) return { state: "ok", note: t("pulling") };
  return { state: "ok", note: t("listening") };
}

async function render(): Promise<void> {
  const box = $("connections");
  const [pairings, lastPosts] = await Promise.all([loadPairings(), loadLastPosts()]);
  if (pairings.length === 0) {
    box.replaceChildren(el("p", "note", t("noPairings")));
    return;
  }
  box.replaceChildren();
  for (const pairing of pairings) {
    const last = lastPosts[pairing.connectionId];
    const state = health(last);
    const row = el("div", "conn");
    row.append(
      el("span", `dot ${state.state}`),
      el("span", "label", pairing.label),
      el("span", "when", last ? new Date(last.at).toLocaleTimeString() : "-"),
    );
    box.append(row, el("p", "note", state.note));
  }
}

$("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/** Opens the service rather than searching for an existing tab: no `tabs` permission, and none requested. */
$("service").addEventListener("click", () => {
  const home = ADAPTERS[0]?.serviceHome;
  if (home) chrome.tabs.create({ url: home });
  window.close();
});

void render();
