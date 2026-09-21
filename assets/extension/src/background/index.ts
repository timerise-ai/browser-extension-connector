import { ADAPTERS } from "../adapters";
import type { ServiceHttp } from "../adapters/types";
import type {
  DiagnoseRequest,
  PollRequest,
  RelayFetchRequest,
  RelayFetchResult,
  RelayPing,
  RelayStatusRequest,
  RelayStatusResult,
  TapMessage,
} from "../shared/messages";
import { t } from "../shared/strings";
import { bindPairing, loadLastPosts, loadPairings, recordLastPost } from "./config";
import { ALARM, DEFAULT_POLL_MS, KEEPALIVE_PORT, RELAY_TIMEOUT_MS, SLOW_POLL_MS } from "./constants";
import { diagnose } from "./diagnostics";
import { Engine } from "./engine";
import { PortRegistry } from "./ports";
import { RecordQueue, chromeStore } from "./queue";

/**
 * The service worker: the only place with a loop, and only Chrome plumbing;
 * the logic is in `engine.ts`.
 *
 * Its cadence is the honest part of this module. MV3 evicts an idle worker
 * after roughly 30 seconds, and `chrome.alarms` will not fire more often than
 * once a minute. So:
 *
 *  - **A service tab is open**: the relay holds a port and pings it every
 *    20 s, which keeps the worker alive, and the loop runs on `setInterval`
 *    at the host's requested cadence.
 *  - **No service tab is open**: the alarm floor applies: once a minute.
 *  - **The browser is closed**: nothing happens at all, and the host's
 *    health badge is how anyone finds out.
 */

const store = chromeStore();
const queue = new RecordQueue(store);

// --- the relay: requests performed in the service page's session --------------

const ports = new PortRegistry<chrome.runtime.Port>();
const pending = new Map<string, (result: RelayFetchResult) => void>();
const pendingStatus = new Map<string, (result: RelayStatusResult) => void>();
let relaySeq = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT) return;
  ports.add(port);
  port.onMessage.addListener((msg: RelayFetchResult | RelayStatusResult | RelayPing) => {
    // A ping's arrival has already done its job: it reset the worker's idle timer.
    if (msg?.type === "relay-ping") return;
    if (msg?.type === "relay-status-result") {
      pendingStatus.get(msg.id)?.(msg);
      pendingStatus.delete(msg.id);
      return;
    }
    if (msg?.type !== "relay-fetch-result") return;
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  port.onDisconnect.addListener(() => {
    ports.remove(port);
    if (ports.size > 0) return;
    // The last tab went: every in-flight request dies with it. Failing them
    // explicitly keeps a pull from hanging until its timeout on a closed page.
    for (const [id, resolve] of pending) {
      resolve({ type: "relay-fetch-result", id, ok: false, status: 0, body: null, error: t("serviceTabClosed") });
    }
    pending.clear();
    pendingStatus.clear();
    schedule(SLOW_POLL_MS);
  });
  // A service tab just opened: the fast loop is available again.
  schedule(engine.currentPollMs);
});

/**
 * Rejects when no service tab is open rather than falling back to a
 * worker-side `fetch`: the worker has no session, so the fallback would
 * return a login page that parses as "zero rows" and look like a finished pull.
 */
const http: ServiceHttp = async (req) => {
  const port = ports.any();
  if (!port) throw new Error(t("noServiceTab"));
  const id = `r${(relaySeq += 1)}`;
  const message: RelayFetchRequest = { type: "relay-fetch", id, url: req.url, method: req.method, body: req.body };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t("serviceTimeout")));
    }, RELAY_TIMEOUT_MS);
    pending.set(id, (result) => {
      clearTimeout(timeout);
      resolve({ ok: result.ok, status: result.status, body: result.body });
    });
    try {
      port.postMessage(message);
    } catch (err) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
};

/** `null` when no tab is open or it does not answer in time: ordinary states, not errors. */
function relayStatus(): Promise<RelayStatusResult | null> {
  const port = ports.any();
  if (!port) return Promise.resolve(null);
  const id = `s${(relaySeq += 1)}`;
  const message: RelayStatusRequest = { type: "relay-status", id };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingStatus.delete(id);
      resolve(null);
    }, 3_000);
    pendingStatus.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
    try {
      port.postMessage(message);
    } catch {
      clearTimeout(timeout);
      pendingStatus.delete(id);
      resolve(null);
    }
  });
}

// --- the loop ---------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

function schedule(intervalMs: number): void {
  if (timer) clearInterval(timer);
  // Only meaningful while the worker is alive; the alarm below is the floor.
  timer = setInterval(() => void engine.tick(), intervalMs);
}

const engine = new Engine(
  {
    queue,
    store,
    adapters: ADAPTERS,
    loadPairings,
    bindPairing,
    recordLastPost,
    loadLastPosts,
    http,
    relayStatus,
    onPollMs: schedule,
  },
  DEFAULT_POLL_MS,
);

/**
 * The once-a-minute floor, created only when it is missing.
 *
 * `chrome.alarms.create` **replaces** an alarm of the same name and restarts
 * its period, so calling it unconditionally at module scope (which runs on
 * every worker startup) pushed the next fire a full minute away each time
 * the worker woke. A worker revived and evicted more often than that never
 * reached its own alarm, and the floor guaranteed nothing.
 */
async function ensureAlarm(): Promise<void> {
  if (await chrome.alarms.get(ALARM)) return;
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void engine.tick();
});

// --- messages from the relay and the extension pages ---------------------------

chrome.runtime.onMessage.addListener(
  (message: TapMessage | DiagnoseRequest | PollRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (message?.type === "diagnose") {
      // Errors are returned rather than thrown: the options page has no useful
      // way to render a rejected `sendMessage`.
      void diagnose(engine, message.connectionId)
        .then((report) => sendResponse({ ok: true, report }))
        .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
    if (message?.type === "poll") {
      // A pairing was just made; somebody is watching the host for "connected".
      void engine.tick();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== "tap") return;
    void engine
      .handleTap(message.payload)
      .catch((err: unknown) => console.warn("[connector] tap:", err))
      .then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async reply
  },
);

/**
 * Startup, in the one order that works. The immediate `tick()` is the
 * load-bearing part: `schedule` only arms a `setInterval`, whose first fire is
 * a full interval away, and a worker revived for a single event is routinely
 * evicted before then. Without a poll on the way up, a browser that keeps
 * waking the worker for short bursts can go a long time without posting at
 * all, which reads in the host as silence from a machine that is plainly on.
 */
async function bootstrap(): Promise<void> {
  await engine.loadAccountId();
  await ensureAlarm();
  schedule(engine.currentPollMs);
  await engine.tick();
}

chrome.runtime.onInstalled.addListener(() => void bootstrap());
void bootstrap();
