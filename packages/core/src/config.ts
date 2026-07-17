import type { PortalConfig } from "./types.js";

/** Production hosts, baked in (§1). Overridable via `PortalConfig.apiUrl`/`realtimeUrl`. */
export const DEFAULT_API_URL = "https://api.useportal.co";
export const DEFAULT_REALTIME_URL = "wss://realtime.useportal.co";

export interface ResolvedHosts {
  /** HTTP base for publish, history, and members (no trailing slash). */
  apiUrl: string;
  /** WebSocket base for channel and inbox upgrades (no trailing slash). */
  realtimeUrl: string;
}

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** Resolve the effective hosts, applying overrides and normalising trailing slashes. */
export function resolveHosts(config: PortalConfig): ResolvedHosts {
  return {
    apiUrl: trimTrailingSlash(config.apiUrl ?? DEFAULT_API_URL),
    realtimeUrl: trimTrailingSlash(config.realtimeUrl ?? DEFAULT_REALTIME_URL),
  };
}
