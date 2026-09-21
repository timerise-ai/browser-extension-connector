/**
 * The slice of the MV3 API this extension actually uses.
 *
 * Hand-written rather than `@types/chrome`, for two reasons. The build stays
 * dependency-free; and a hand-written surface is a **list of what we touch**,
 * which is exactly the review question the Web Store asks. Adding an API here
 * is a visible diff, the same property `PERMISSIONS.md` is trying to preserve.
 * Swap for `@types/chrome` if your host already has it; nothing below conflicts.
 */
declare namespace chrome {
  namespace runtime {
    type Port = {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(cb: (message: never) => void): void };
      onDisconnect: { addListener(cb: () => void): void };
    };
    const lastError: { message?: string } | undefined;
    function connect(info: { name: string }): Port;
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    /** Opens the options page. The only navigation the popup performs itself. */
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(
        cb: (
          message: never,
          sender: { tab?: { id?: number }; origin?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onConnect: { addListener(cb: (port: Port) => void): void };
    const onInstalled: { addListener(cb: (details: { reason: string }) => void): void };
  }

  namespace storage {
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }

  namespace alarms {
    function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
    function get(name: string): Promise<{ name: string } | undefined>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
  }

  /**
   * `tabs.create` only: opening a URL needs no `tabs` permission, and none is
   * requested. Nothing here reads, lists or inspects the user's tabs.
   */
  namespace tabs {
    function create(props: { url: string }): Promise<{ id?: number }>;
  }

  namespace permissions {
    function request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }
}

/** Injected by the build from `package.json`; reported to the host as telemetry. */
declare const __AGENT_VERSION__: string;
/** Injected by the build from the adapter: the URL pattern the tap captures. */
declare const __TAP_CAPTURE__: string;
/** Injected by the build from the adapter: request headers the tap records for replay. */
declare const __TAP_AUTH_HEADERS__: string[];
