import { ChannelHandleImpl } from "./channel.js";
import { resolveHosts, type ResolvedHosts } from "./config.js";
import { devWarn } from "./env.js";
import type {
  ChannelHandle,
  ChannelOptions,
  InboxHandle,
  PortalConfig,
} from "./types.js";

interface ChannelEntry {
  handle: ChannelHandleImpl;
  /** The options the handle was created with, for the first-creation-wins warning. */
  optionsKey: string;
}

const optionsKey = (options: ChannelOptions | undefined): string =>
  JSON.stringify({
    history: options?.history ?? null,
    metadata: options?.metadata ?? null,
  });

/**
 * The Portal client (§1).
 *
 * Construction is synchronous and passive: it stores config and creates empty registries,
 * with no network, no token fetch, and no validation. The first `acquire()` (or the first
 * inbox subscription) is the first network moment — safe to construct at module scope
 * before any user exists.
 */
export class Portal {
  readonly #config: PortalConfig;
  readonly #hosts: ResolvedHosts;
  readonly #channels = new Map<string, ChannelEntry>();

  constructor(config: PortalConfig) {
    this.#config = config;
    this.#hosts = resolveHosts(config);
  }

  /**
   * Registry lookup-or-create: the same object for the same id. No network until
   * `acquire()`. Options apply at first creation — a later call with different options
   * returns the existing handle and ignores them (dev-mode warning; silent in production).
   */
  channel<M = unknown>(channelId: string, options?: ChannelOptions): ChannelHandle<M> {
    const existing = this.#channels.get(channelId);
    if (existing !== undefined) {
      if (options !== undefined && optionsKey(options) !== existing.optionsKey) {
        devWarn(
          `channel("${channelId}") was already created with different options; ` +
            `the original options are kept and these are ignored`,
        );
      }
      return existing.handle as unknown as ChannelHandle<M>;
    }

    const handle = new ChannelHandleImpl({
      channelId,
      hosts: this.#hosts,
      apiKey: this.#config.apiKey,
      token: this.#config.token,
      options,
    });
    this.#channels.set(channelId, { handle, optionsKey: optionsKey(options) });
    return handle as unknown as ChannelHandle<M>;
  }

  /** Lazy singleton — created and subscribed on first use, never at construction. */
  inbox(): InboxHandle {
    throw new Error("inbox() is not implemented.");
  }
}
