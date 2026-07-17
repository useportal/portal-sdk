/**
 * `@portalsdk/core` — the framework-agnostic Portal client.
 *
 * The public surface is the client SDK contract: the {@link Portal} class, the error
 * hierarchy, and the observable types. Transport concerns (`seq`, frames, reconnect
 * tokens, `partysocket`) live below this edge and are never exported.
 */

export { Portal } from "./portal.js";

export {
  PortalError,
  InvalidApiKeyError,
  BlockedError,
  TokenExpiredError,
  NotMemberError,
  ChannelAtCapacityError,
  AnonymousNotAllowedError,
  NotYetSupportedError,
  DegradedError,
} from "./errors.js";

export type * from "./types.js";
