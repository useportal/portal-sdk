import {
  isBatch,
  isChannelReady,
  isDirect,
  isError,
  isReassign,
  isRetract,
  parseChannelFrame,
  serializeFrame,
  type ChannelReadyFrame,
  type EphemeralFrame,
  type PublishBody,
  type WireMessage,
} from "@portalsdk/wire-protocol";

import type { ResolvedHosts } from "./config.js";
import { Emitter } from "./emitter.js";
import { BlockedError, DegradedError, PortalError } from "./errors.js";
import { getHttpClientFactory } from "./http/factory.js";
import type { HttpClient } from "./http/types.js";
import { MessageBuffer } from "./message-buffer.js";
import { classifyRefusal } from "./refusal.js";
import { Store } from "./store.js";
import { isStaticToken, resolveToken, type TokenSource } from "./token.js";
import { getSocketFactory } from "./transport/factory.js";
import type { Socket, SocketEvent } from "./transport/types.js";
import type {
  ChannelEvents,
  ChannelInfo,
  ChannelSnapshot,
  SendAck,
  SendInput,
} from "./types.js";
import { buildChannelUpgradeUrl } from "./url.js";

/** Max client-side jitter before a gap-fill range fetch (implementation-notes). */
const GAP_FILL_MAX_JITTER_MS = 2_000;

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
  /** Initial backfill size, or "none" for a live-only start. */
  history: number | "none";
}

/**
 * Owns one channel's socket lifecycle and its message plane: connect, `ready` ingestion,
 * ordering/dedup/gap-fill, retraction, optimistic send + ack, history paging, refusal
 * handling, reconnect reconciliation, and the status machine. It holds the channel's
 * public snapshot store and event emitter; the handle is a thin refcounting shell over it.
 */
export class ChannelConnection {
  readonly store = new Store<ChannelSnapshot>(idleSnapshot());
  readonly events = new Emitter<ChannelEvents<unknown>>();

  readonly #deps: ConnectionDeps;
  readonly #buffer: MessageBuffer;
  #socket: Socket | undefined;
  #http: HttpClient | undefined;
  #disposed = false;

  /** Sticky reconnect hint from the last `ready`; echoed on the next upgrade. */
  #leaf: string | undefined;
  /** Whether this session's one token-refresh retry has been spent. */
  #tokenRetryUsed = false;
  /** Extension namespace → transport (`ws`/`http`), from `ready.bindings`. */
  #bindings: Record<string, string> | undefined;
  /** Namespaces whose extension is currently degraded (populated once degraded status lands). */
  readonly #degraded = new Set<string>();

  #clientTag = 0;
  #loadingPrevious = false;
  #loadPreviousInFlight: Promise<boolean> | undefined;
  /** In-flight gap-fill ranges, keyed `from-to`, to avoid duplicate fetches. */
  readonly #inflightGaps = new Set<string>();

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
    this.#buffer = new MessageBuffer(deps.channelId);
  }

  // ── Lifecycle ─────────────────────────────────────────────

  connect(): void {
    if (this.#socket !== undefined) return;
    this.#disposed = false;
    this.#tokenRetryUsed = false;
    this.#setStatus("connecting");
    this.#socket = getSocketFactory()({ url: this.#buildUrl, onEvent: this.#onEvent });
    if (this.#deps.history !== "none") this.#backfill(this.#deps.history);
  }

  teardown(): void {
    this.#disposed = true;
    this.#socket?.close();
    this.#socket = undefined;
    this.#http = undefined;
    this.#leaf = undefined;
    this.#bindings = undefined;
    this.#loadingPrevious = false;
    this.#loadPreviousInFlight = undefined;
    this.#inflightGaps.clear();
    this.#buffer.reset();
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
      last: this.#buffer.contiguousSeq(),
    });
  };

  // ── Event handling ────────────────────────────────────────

  readonly #onEvent = (event: SocketEvent): void => {
    if (this.#disposed) return;
    switch (event.type) {
      case "open":
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
        return;
    }
  };

  #onMessage(raw: string): void {
    const frame = parseChannelFrame(raw);
    if (frame === null) return;
    if (isChannelReady(frame)) return this.#onReady(frame);
    if (isBatch(frame)) return this.#deliver(frame.msgs);
    if (isDirect(frame)) return this.#deliver([frame.msg]);
    if (isRetract(frame)) return this.#onRetract(frame.id, frame.seq);
    if (isError(frame)) return this.#emitError(this.#inSessionError(frame.code, frame.reason));
    if (isReassign(frame)) {
      this.#leaf = frame.leaf;
      this.#socket?.reconnect();
      return;
    }
    // presence / activity / pong: parsed and not modeled here.
  }

  #onReady(frame: ChannelReadyFrame): void {
    this.#leaf = frame.leaf;
    this.#bindings = frame.bindings;
    this.#tokenRetryUsed = false;

    const heldBefore = this.#buffer.contiguousSeq();
    this.#buffer.setMe(frame.me.id, frame.me.anon);
    this.#buffer.setBaseline(frame.seq);

    // Reconnect reconciliation: anything persisted between what we held and the new head
    // was missed and must be range-fetched — never assume the replay covered it.
    if (heldBefore !== undefined && frame.seq > heldBefore) {
      this.#scheduleGapFills([[heldBefore + 1, frame.seq]]);
    }

    const info: ChannelInfo = {
      id: frame.channel.id,
      mode: frame.channel.mode,
      ...(frame.channel.name !== undefined ? { name: frame.channel.name } : {}),
      ...(frame.channel.meta !== undefined ? { meta: frame.channel.meta } : {}),
    };
    const me = { id: frame.me.id, anon: frame.me.anon, claims: frame.me.claims };

    this.store.update((prev) => ({
      ...prev,
      status: "ready",
      info,
      me,
      messages: this.#buffer.messages(),
      hasPrevious: this.#buffer.hasPrevious(),
    }));
    this.events.emit("status", "ready");
  }

  #deliver(msgs: readonly WireMessage[]): void {
    const { delivered, gaps } = this.#buffer.ingest(msgs);
    const meId = this.store.getSnapshot().me?.id;
    for (const msg of delivered) {
      this.events.emit("message", msg);
      if (meId !== undefined && (msg.mentions?.some((m) => m.userId === meId) ?? false)) {
        this.events.emit("mention", msg);
      }
    }
    this.#publishState();
    this.#scheduleGapFills(gaps);
  }

  #onRetract(id: string, seq: number): void {
    this.#buffer.retract(seq);
    this.events.emit("retract", id);
    this.#publishState();
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

  // ── Sending ───────────────────────────────────────────────

  send(input: SendInput<unknown>): Promise<SendAck> {
    const route = this.#extensionRoute(input.type);
    if (route !== undefined) {
      if (this.#degraded.has(route.namespace)) {
        return Promise.reject(
          new DegradedError(`The "${route.namespace}" extension is degraded.`),
        );
      }
      return route.transport === "ws"
        ? this.#sendEphemeralFrame(input.type, input.content)
        : this.#publishOnce(input);
    }
    if (input.ephemeral === true) {
      return this.#sendEphemeralFrame(input.type, input.content);
    }
    return this.#sendPersistent(input);
  }

  async #sendPersistent(input: SendInput<unknown>): Promise<SendAck> {
    const tempId = this.#nextTag();
    const persistent = input as Extract<SendInput<unknown>, { ephemeral?: false }>;
    this.#buffer.addOptimistic({
      tempId,
      type: input.type ?? "message",
      content: input.content,
      to: persistent.to,
      mentions: persistent.mentions,
      timestamp: Date.now(),
    });
    this.#publishState();

    let outcome;
    try {
      outcome = await this.#httpClient().publish(this.#deps.channelId, this.#body(input));
    } catch (cause) {
      this.#buffer.rollback(tempId);
      this.#publishState();
      throw new PortalError("network_error", "The publish request failed.");
    }
    if (!outcome.ok) {
      this.#buffer.rollback(tempId);
      this.#publishState();
      throw this.#publishError(outcome.code, outcome.reason);
    }
    this.#buffer.ack(tempId, outcome.ack);
    this.#publishState();
    return { id: outcome.ack.id, timestamp: outcome.ack.timestamp };
  }

  /** An HTTP-routed extension send: a publish with no optimistic channel-message insert. */
  async #publishOnce(input: SendInput<unknown>): Promise<SendAck> {
    const outcome = await this.#httpClient().publish(this.#deps.channelId, this.#body(input));
    if (!outcome.ok) throw this.#publishError(outcome.code, outcome.reason);
    return { id: outcome.ack.id, timestamp: outcome.ack.timestamp };
  }

  #sendEphemeralFrame(type: string | undefined, content: unknown): Promise<SendAck> {
    const cl = this.#nextTag();
    const frame: EphemeralFrame = { t: "ephemeral", cl, type: type ?? "message", content };
    this.#socket?.send(serializeFrame(frame));
    return Promise.resolve({ id: cl, timestamp: Date.now() });
  }

  // ── History ───────────────────────────────────────────────

  loadPrevious(): Promise<boolean> {
    if (this.#loadPreviousInFlight !== undefined) return this.#loadPreviousInFlight;
    if (!this.#buffer.hasPrevious()) return Promise.resolve(false);

    this.#loadingPrevious = true;
    this.#publishState();
    const pageSize = this.#deps.history === "none" ? 50 : this.#deps.history;
    const before = this.#buffer.lowestSeq();

    const promise = (async (): Promise<boolean> => {
      try {
        const page = await this.#httpClient().history(this.#deps.channelId, {
          ...(before !== undefined ? { before } : {}),
          limit: pageSize,
        });
        this.#buffer.ingestHistory(page.msgs);
        this.#buffer.setHasPrevious(page.hasMore);
        return page.hasMore;
      } finally {
        this.#loadingPrevious = false;
        this.#loadPreviousInFlight = undefined;
        this.#publishState();
      }
    })();
    this.#loadPreviousInFlight = promise;
    return promise;
  }

  #backfill(limit: number): void {
    void this.#httpClient()
      .history(this.#deps.channelId, { limit })
      .then((page) => {
        if (this.#disposed) return;
        this.#buffer.ingestHistory(page.msgs);
        this.#buffer.setHasPrevious(page.hasMore);
        this.#publishState();
      })
      .catch(() => {
        // A failed initial backfill leaves the live stream intact; nothing to surface.
      });
  }

  #scheduleGapFills(gaps: readonly [number, number][]): void {
    for (const [from, to] of gaps) {
      const key = `${from}-${to}`;
      if (this.#inflightGaps.has(key)) continue;
      this.#inflightGaps.add(key);
      setTimeout(
        () => void this.#fillGap(from, to, key),
        Math.random() * GAP_FILL_MAX_JITTER_MS,
      );
    }
  }

  async #fillGap(from: number, to: number, key: string): Promise<void> {
    try {
      if (this.#disposed) return;
      const page = await this.#httpClient().history(this.#deps.channelId, { from, to });
      if (this.#disposed) return;
      this.#buffer.ingestHistory(page.msgs);
      this.#publishState();
    } catch {
      // Leave the gap for the next reconnect reconciliation to retry.
    } finally {
      this.#inflightGaps.delete(key);
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  #extensionRoute(
    type: string | undefined,
  ): { namespace: string; transport: "ws" | "http" } | undefined {
    if (type === undefined || this.#bindings === undefined) return undefined;
    for (const [namespace, transport] of Object.entries(this.#bindings)) {
      if (type.startsWith(namespace)) {
        return { namespace, transport: transport === "ws" ? "ws" : "http" };
      }
    }
    return undefined;
  }

  #body(input: SendInput<unknown>): PublishBody {
    const persistent = input as Extract<SendInput<unknown>, { ephemeral?: false }>;
    return {
      content: input.content,
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(persistent.kind !== undefined ? { kind: persistent.kind } : {}),
      ...(persistent.to !== undefined ? { to: persistent.to } : {}),
      ...(persistent.mentions !== undefined ? { mentions: persistent.mentions } : {}),
    };
  }

  #publishError(code: string, reason?: string): PortalError {
    if (code === "blocked_by_middleware") {
      return new BlockedError(reason ?? "The message was blocked.");
    }
    return new PortalError(code, reason ?? "The message was rejected.");
  }

  #inSessionError(code: string, reason?: string): PortalError {
    if (code === "blocked_by_middleware") {
      return new BlockedError(reason ?? "The message was blocked.");
    }
    return new PortalError(code, reason ?? "The request was rejected.");
  }

  #httpClient(): HttpClient {
    if (this.#http === undefined) {
      this.#http = getHttpClientFactory()({
        apiUrl: this.#deps.hosts.apiUrl,
        apiKey: this.#deps.apiKey,
        token: this.#deps.token,
      });
    }
    return this.#http;
  }

  #nextTag(): string {
    return `cl_${++this.#clientTag}`;
  }

  #publishState(): void {
    this.store.update((prev) => ({
      ...prev,
      messages: this.#buffer.messages(),
      hasPrevious: this.#buffer.hasPrevious(),
      isLoadingPrevious: this.#loadingPrevious,
    }));
  }

  /**
   * SPEC: `ChannelEvents` has no dedicated error event, so an in-session error is delivered
   * through the `status` event's error argument — the only error-carrying channel in the
   * contract — without changing the status value.
   */
  #emitError(error: PortalError): void {
    this.events.emit("status", this.#currentStatus(), error);
  }

  #fail(error: PortalError): void {
    this.#socket?.close();
    this.store.update((prev) => ({ ...prev, status: "blocked" }));
    this.events.emit("status", "blocked", error);
  }

  #currentStatus(): ChannelSnapshot["status"] {
    return this.store.getSnapshot().status;
  }

  #setStatus(status: ChannelSnapshot["status"]): void {
    if (this.#currentStatus() === status) return;
    this.store.update((prev) => ({ ...prev, status }));
    this.events.emit("status", status);
  }
}
