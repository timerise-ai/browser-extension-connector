/**
 * Telling an orphaned content script apart from a transient failure.
 *
 * Reloading or updating an extension leaves the content scripts already running
 * in open tabs alive on the page but detached from the extension: every
 * `chrome.runtime.*` call from then on throws. That state is **terminal** —
 * only loading the page again injects fresh scripts — while the failures it is
 * easily confused with (a service worker mid-restart, a port replaced by an
 * update) are worth retrying.
 *
 * Getting it wrong is not cosmetic in either direction: retrying a dead context
 * produces an uncaught error every second for as long as the tab stays open,
 * and giving up on a live one silently stops syncing.
 *
 * Matched on the message because Chrome gives no error code for it.
 */
export function isContextInvalidated(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Chrome has shipped both "Extension context invalidated." and the shorter
  // form; other surfaces phrase it as a message-port failure with the same cause.
  return /context invalidated|Extension context|message port closed/i.test(err.message);
}
