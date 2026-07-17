import {
  isChannelReady,
  parseChannelFrame,
  type ChannelReadyFrame,
} from "@portalsdk/wire-protocol";

import type { ResolvedHosts } from "./config.js";
import { Emitter } from "./emitter.js";
import type { PortalError } from "./errors.js";
import { classifyRefusal } from "./refusal.js";
import { Store } from "./store.js";
import { isStaticToken, resolveToken, type TokenSource } from "./token.js";
import { getSocketFactory } from "./transport/factory.js";
import type { Socket, SocketEvent } from "./transport/types.js";
import type { ChannelEvents, ChannelInfo, ChannelSnapshot } from "./types.js";
import { buildChannelUpgradeUrl } from "./url.js";

/** The idle snapshot a channel starts (and returns) to. `hasPrevious` is optimistic. */
const idleSnapshot = (): ChannelSnapshot => ({
  messages: [],
  presence: undefined,
  activity: [],
  status: "idle",
  unread: 0,
  info: undefined,
  me: undefined,
  isLoadingPrevious: false,
  hasPrevious: true,
});

export interface ConnectionDeps {
  channelId: string;
  hosts: ResolvedHosts;
  apiKey: string;
  token: TokenSource;
  metadata: Record<string, unknown> | undefined;
}

/**
 * Owns one channel's socket lifecycle: connect, `ready` ingestion, refusal handling,
 * reconnect reconciliation, and the status machine. It holds the channel's public
 * snapshot store and event emitter; the handle is a thin refcounting shell over it.
 *
 * It captures the connect snapshot — `me`, channel info, the `leaf` hint, and the seq
 * baseline — and drives status. The message, presence, and read-state planes build on the
 * same store.
 */
export class ChannelConnection {
  readonly store = new Store<ChannelSnapshot>(idleSnapshot());
  readonly events = new Emitter<ChannelEvents<unknown>>();

  readonly #deps: ConnectionDeps;
  #socket: Socket | undefined;
  #disposed = false;

  /** Sticky reconnect hint from the last `ready`; echoed on the next upgrade. */
  #leaf: string | undefined;
  /** Channel head at the last `ready`; the `last=` reconnect baseline and gap-fill anchor. */
  #heldSeq: number | undefined;
  /** Whether this session's one token-refresh retry has been spent. */
  #tokenRetryUsed = false;

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Open the socket. Idempotent — a second call while connected is a no-op. */
  connect(): void {
    if (this.#socket !== undefined) return;
    this.#disposed = false;
    this.#tokenRetryUsed = false;
    this.#setStatus("connecting");
    this.#socket = getSocketFactory()({ url: this.#buildUrl, onEvent: this.#onEvent });
  }

  /** Close the socket and return to idle. */
  teardown(): void {
    this.#disposed = true;
    this.#socket?.close();
    this.#socket = undefined;
    this.#leaf = undefined;
    this.#heldSeq = undefined;
    this.store.set(idleSnapshot());
  }

  // ── URL construction ──────────────────────────────────────

  readonly #buildUrl = async (): Promise<string> => {
    const token = await resolveToken(this.#deps.token);
    return buildChannelUpgradeUrl({
      realtimeUrl: this.#deps.hosts.realtimeUrl,
      channelId: this.#deps.channelId,
      token,
      apiKey: this.#deps.apiKey,
      leaf: this.#leaf,
      meta: this.#deps.metadata,
      last: this.#heldSeq,
    });
  };

  // ── Event handling ────────────────────────────────────────

  readonly #onEvent = (event: SocketEvent): void => {
    if (this.#disposed) return;
    switch (event.type) {
      case "open":
        // Connected; awaiting the `ready` frame before we report ready. Status stays
        // "connecting" (first attempt) or "reconnecting" (subsequent) until then.
        return;
      case "message":
        this.#onMessage(event.data);
        return;
      case "refused":
        this.#onRefused(event.code, event.reason);
        return;
      case "closed":
        if (this.#currentStatus() !== "blocked") this.#setStatus("reconnecting");
        return;
      case "error":
        // Transient; the transport is reconnecting. Nothing observable to change.
        return;
    }
  };

  #onMessage(raw: string): void {
    const frame = parseChannelFrame(raw);
    if (frame === null) return;
    if (isChannelReady(frame)) {
      this.#onReady(frame);
      return;
    }
    // Only the connect snapshot is consumed here; data, mutation, presence, and activity
    // frames are ignored.
  }

  #onReady(frame: ChannelReadyFrame): void {
    this.#leaf = frame.leaf;
    this.#heldSeq = frame.seq;
    this.#tokenRetryUsed = false;

    const info: ChannelInfo = {
      id: frame.channel.id,
      mode: frame.channel.mode,
      ...(frame.channel.name !== undefined ? { name: frame.channel.name } : {}),
      ...(frame.channel.meta !== undefined ? { meta: frame.channel.meta } : {}),
    };
    const me = {
      id: frame.me.id,
      anon: frame.me.anon,
      claims: frame.me.claims,
    };

    this.store.update((prev) => ({ ...prev, status: "ready", info, me }));
    this.events.emit("status", "ready");
  }

  #onRefused(code: string, reason?: string): void {
    const decision = classifyRefusal(code, reason);
    if (decision.kind === "token-expired") {
      if (isStaticToken(this.#deps.token) || this.#tokenRetryUsed) {
        this.#fail(decision.error);
        return;
      }
      this.#tokenRetryUsed = true;
      this.#socket?.reconnect();
      return;
    }
    this.#fail(decision.error);
  }

  /** Settle at the terminal `blocked` status and stop reconnecting. */
  #fail(error: PortalError): void {
    this.#socket?.close();
    this.store.update((prev) => ({ ...prev, status: "blocked" }));
    this.events.emit("status", "blocked", error);
  }

  // ── Status helpers ────────────────────────────────────────

  #currentStatus(): ChannelSnapshot["status"] {
    return this.store.getSnapshot().status;
  }

  #setStatus(status: ChannelSnapshot["status"]): void {
    if (this.#currentStatus() === status) return;
    this.store.update((prev) => ({ ...prev, status }));
    this.events.emit("status", status);
  }
}
