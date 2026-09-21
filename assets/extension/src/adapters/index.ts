import type { ConnectorAdapter } from "./types";
import { stubAdapter } from "./stub";

/** Every adapter this build ships. A pairing's `provider` selects one by `id`. */
export const ADAPTERS: ConnectorAdapter[] = [stubAdapter];
