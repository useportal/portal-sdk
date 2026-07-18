import type { Portal } from "@portalsdk/core";
import type { ReactElement, ReactNode } from "react";

import { PortalContext } from "./context.js";

export interface PortalProviderProps {
  /** The app's Portal client; its lifecycle stays owned by the caller. */
  client: Portal;
  children: ReactNode;
}

/**
 * Supplies a {@link Portal} client to the hooks below it.
 *
 * The provider is passive: it only publishes `client` on context. Connections are opened and
 * closed by the hooks (via the handle refcount), not here — so there is nothing for the
 * provider to tear down on unmount, and the `Portal` instance's own lifecycle stays owned by
 * whoever constructed it.
 */
export function PortalProvider({ client, children }: PortalProviderProps): ReactElement {
  return <PortalContext.Provider value={client}>{children}</PortalContext.Provider>;
}
