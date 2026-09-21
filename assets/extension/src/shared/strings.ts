/**
 * Every user-facing string in the extension, keyed. The host translates this
 * one file; nothing else in the extension carries a literal. Worker-side
 * messages travel to the host in `SyncRequest.error`, so they are here too.
 */
export const STRINGS = {
  // worker
  noServiceTab: "no service tab is open",
  serviceTimeout: "timed out waiting for the service to answer",
  serviceTabClosed: "the service tab was closed",
  accountUnknown: "account not recognised: open the service and load a page that shows it",
  hostUnreachable: "the host app did not answer",
  pairingRevoked: "pairing expired or was revoked: pair again in the extension settings",
  pullProgressNotSaved: "could not save pull progress in the host app",
  pullPaused: "pull paused",
  missingExternalRef: "no service id for this item",
  writeUnverified: "writing to the service is not yet verified on a live account",
  unknownCommand: "unknown command kind",
  // relay
  badUrl: "invalid address",
  noCredentials: "no service credentials seen yet: open the service and sign in",
  wrongOrigin: "credentials belong to a different origin than the request",
  // diagnostics
  checkPairing: "Pairing",
  notPairedHere: "This connection is not paired in this browser.",
  checkHost: "Host app",
  hostOk: "Answers and accepts data.",
  hostNoAnswer: "No answer from {origin}. Check the address and your connection.",
  checkEnabled: "Connection enabled",
  enabledOk: "Enabled in the host app.",
  enabledOff: "Paused in the host app. Enable it there.",
  checkServiceTab: "Service tab",
  serviceTabMissing: "No service tab is open. Pulls and commands need one, signed in.",
  checkSession: "Service session",
  sessionOk: "Signed in ({origin}).",
  sessionMissing: "The tab is open but no signed-in request has been seen yet. Load a page.",
  checkAccount: "Recognised account",
  accountMissing: "Account not recognised. Open a page in the service that shows it.",
  accountMismatch: "This connection is bound to account {bound}; the tab shows {observed}. Switch the service to the right account.",
  accountOk: "Account {account}",
  checkBuffer: "Offline buffer",
  bufferOk: "{queued} records waiting to be sent.",
  bufferDropped: "{queued} queued, {dropped} dropped after overflow. They will be observed again.",
  checkWrite: "Writes to the service",
  writeOn: "Enabled.",
  writeOff: "Disabled: writes are not yet verified on a live account. Records go up; commands that write do not run.",
  // options
  invalidHost: "Invalid host app address.",
  invalidPin: "The pairing code is 4 to 8 digits.",
  permissionDenied: "Without access to the host app's address the extension cannot send data.",
  wrongPin: "Wrong code.",
  noConnections: "This tenant has no connection yet. Create one in the host app.",
  chooseConnection: "Tenant: {name}. Choose a connection.",
  pairFailed: "Pairing failed.",
  listFailed: "Could not list connections.",
  serverFault: "{detail} ({status}): a fault on the host app's side, not in the pairing. Pass this message to whoever runs it.",
  networkFailed: "Could not reach {origin}. Check the address and your connection.{detail}",
  paired: "Paired with \"{label}\". Connecting to the host app...",
  unpairedLocally: "Removed from this browser. To revoke the token, disconnect it in the host app.",
  testConnection: "Test connection",
  unpair: "Disconnect",
  unpairConfirm: "Really disconnect?",
  rePair: "(pair again)",
  notChecked: "Not checked",
  checking: "Checking...",
  noReply: "No reply from the extension. Disable and re-enable it.",
  testFailed: "Test failed: {error}",
  summaryOk: "Working",
  summaryWarn: "Working with caveats",
  summaryFail: "Not working",
  upHeading: "Up, to the host app",
  downHeading: "Down, to the service",
  acceptedLast: "Accepted last time",
  duplicates: "Duplicates",
  queued: "Queued",
  dropped: "Dropped",
  lastContact: "Last contact",
  commandsLast: "Commands last time",
  writeState: "Writes",
  writeActive: "active",
  writeDisabled: "disabled",
  // popup
  noPairings: "No paired connections. Pair the extension with the host app in settings.",
  neverPosted: "Nothing sent yet.",
  lastFailed: "The last attempt failed.",
  pausedInHost: "Paused in the host app.",
  stale: "Quiet for a while. Open settings and run a test.",
  pulling: "Pulling data from the service.",
  listening: "Connected and listening for changes.",
} as const;

export type StringKey = keyof typeof STRINGS;

/** `t("hostNoAnswer", { origin })`: `{name}` placeholders, nothing cleverer. */
export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}
