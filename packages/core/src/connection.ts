import {
  isActivity,
  isBatch,
  isChannelReady,
  isDirect,
  isError,
  isPresence,
  isReassign,
  isRetract,
  parseChannelFrame,
  serializeFrame,
  type ActivityUpFrame,
  type ChannelReadyFrame,
  type EphemeralFrame,
  type MetaFrame,
  type PingFrame,
  type PresenceFrame,
  type PublishBody,
  type ThreadNodeWire,
  type WatermarkFrame,
  type WireMessage,
} from "@portalsdk/wire-protocol";


import type { ResolvedHosts } from "./config.js";
import type { Credentials } from "./credentials.js";
import { Emitter } from "./emitter.js";
import { BlockedError, DegradedError, NotYetSupportedError, PortalError } from "./errors.js";

import { getHttpClientFactory } from "./http/factory.js";
import type { HttpClient } from "./http/types.js";
import { Keepalive } from "./keepalive.js";
import { MessageBuffer } from "./message-buffer.js";
import { PresenceTracker } from "./presence.js";
import { classifyRefusal } from "./refusal.js";
import { Store } from "./store.js";
import { getSocketFactory } from "./transport/factory.js";
import type { Socket, SocketEvent } from "./transport/types.js";
import type {
  ActivityEntry,
  ChannelEvents,
  ChannelInfo,
  ChannelSnapshot,
  MemberRow,
  Message,
  SendAck,
  SendInput,
  ThreadNode,
  ThreadPage,
  ThreadsQuery,
  Unsubscribe,
} from "./types.js";
import { buildChannelUpgradeUrl } from "./url.js";


/** Max client-side jitter before a gap-fill range fetch (implementation-notes). */
const GAP_FILL_MAX_JITTER_MS = 2_000;
/** Minimum spacing between outgoing activity signals of the same kind. */
const ACTIVITY_THROTTLE_MS = 3_000;
/** How long a peer's activity survives without a refresh. */
const ACTIVITY_EXPIRY_MS = 5_000;

/** The idle snapshot a channel starts (and returns) to. `hasPrevious` is optimistic. */
const idleSnapshot = (): ChannelSnapshot => ({
  messages: [],
  presence: undefined,
  activity: [],
  status: "idle",
  unread: 0,
  info: undefined,
  me: undefined,
  ext: undefined,
  isLoadingPrevious: false,
  hasPrevious: true,
});

export interface ConnectionDeps {
  channelId: string;
  hosts: ResolvedHosts;
  apiKey: string;
  credentials: Credentials;
  metadata: Record<string, unknown> | undefined;
  /** Initial backfill size, or "none" for a live-only start. */
  history: number | "none";
}

/** Per-thread session state behind a thread lens. Replies themselves live in the buffer. */
interface ThreadState {
  /** Live lens subscriptions; a subscribed thread is re-fetched on the next connect. */
  subscribers: number;
  /** The initial page has been requested this session (a failure clears it for a retry). */
  loaded: boolean;
  inFlight: Promise<boolean> | undefined;
  /** An explicit `loadPrevious` is awaiting — what the lens reports as `isLoadingPrevious`. */
  loading: boolean;
}

const toThreadNode = (wire: ThreadNodeWire): ThreadNode => ({
  id: wire.id,
  ...(wire.parentThreadId !== undefined ? { parentThreadId: wire.parentThreadId } : {}),
  rootThreadId: wire.rootThreadId,
  depth: wire.depth,
  spawnedBy: { id: wire.spawnedBy.id },
  messageCount: wire.threadSeq,
  createdAt: wire.createdAt,
});

const threadOnEphemeralLane = (type: string | undefined): NotYetSupportedError =>
  new NotYetSupportedError(
    `A send of type "${type ?? "message"}" travels as an ephemeral frame and cannot be addressed to a thread.`,
  );

const validationMessage = (reason: string | undefined): string =>

  reason === "thread_depth_exceeded"
    ? "The reply would nest deeper than this channel allows."
    : "The message failed validation.";

const exhaustedThreadPage = (): ThreadPage => ({

  threads: [],
  hasMore: false,
  next: () => Promise.resolve(exhaustedThreadPage()),
});


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
  readonly #presence = new PresenceTracker();
  readonly #keepalive = new Keepalive(() => {
    const ping: PingFrame = { t: "ping" };
    this.#socket?.send(serializeFrame(ping));
  });
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
  /** Whether this connection may publish — drives the degraded-http fallback status. */
  #canPublish = false;
  /** Current presence metadata; re-sent on reconnect and replaced by `setMetadata`. */
  #metadata: Record<string, unknown> | undefined;

  #clientTag = 0;
  #loadingPrevious = false;
  #loadPreviousInFlight: Promise<boolean> | undefined;
  /** In-flight gap-fill ranges, keyed `from-to`, to avoid duplicate fetches. */
  readonly #inflightGaps = new Set<string>();
  /** Live peer activity, keyed `userId:kind`, each on its own absence-expiry timer. */
  readonly #activity = new Map<
    string,
    { entry: ActivityEntry; timer: ReturnType<typeof setTimeout> }
  >();
  /** Last send time per activity kind, for client-side throttling. */
  readonly #activityThrottle = new Map<string, number>();
  /** Session state per thread lens, keyed by thread id. Survives teardown minus the session bits. */
  readonly #threads = new Map<string, ThreadState>();

  constructor(deps: ConnectionDeps) {

    this.#deps = deps;
    this.#buffer = new MessageBuffer(deps.channelId);
    this.#metadata = deps.metadata;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  connect(): void {
    if (this.#socket !== undefined) return;
    this.#disposed = false;
    this.#tokenRetryUsed = false;
    this.#setStatus("connecting");
    this.#socket = getSocketFactory()({ url: this.#buildUrl, onEvent: this.#onEvent });
    if (this.#deps.history !== "none") this.#backfill(this.#deps.history);
    // A thread lens that stayed subscribed across a teardown starts its session over, exactly
    // like the channel's own backfill.
    for (const [threadId, state] of this.#threads) {
      if (state.subscribers > 0) this.#ensureThreadLoaded(threadId);
    }

    // Anonymous mode: the SDK owns the credential, so a mint failure has no other way to
    // surface. Resolve eagerly and turn a failure into a terminal error. Fire-and-forget;
    // on success the token is cached and the socket's own url() reuses it (one mint).
    if (this.#deps.credentials.managed) {
      void this.#deps.credentials.resolve().catch((cause: unknown) => {
        if (!this.#disposed) {
          this.#fail(
            cause instanceof PortalError
              ? cause
              : new PortalError("mint_failed", "Failed to obtain an anonymous token."),
          );
        }
      });
    }
  }

  teardown(): void {
    this.#disposed = true;
    this.#socket?.close();
    this.#socket = undefined;
    this.#http = undefined;
    this.#leaf = undefined;
    this.#bindings = undefined;
    this.#canPublish = false;
    this.#metadata = this.#deps.metadata;
    this.#loadingPrevious = false;
    this.#loadPreviousInFlight = undefined;
    this.#inflightGaps.clear();
    for (const state of this.#threads.values()) {
      state.loaded = false;
      state.inFlight = undefined;
      state.loading = false;
    }
    this.#keepalive.stop();

    this.#clearActivity();
    this.#activityThrottle.clear();
    this.#buffer.reset();
    this.#presence.reset();
    this.store.set(idleSnapshot());
  }

  // ── URL construction ──────────────────────────────────────

  readonly #buildUrl = async (): Promise<string> => {
    const token = await this.#deps.credentials.resolve();
    return buildChannelUpgradeUrl({
      realtimeUrl: this.#deps.hosts.realtimeUrl,
      channelId: this.#deps.channelId,
      token,
      apiKey: this.#deps.apiKey,
      leaf: this.#leaf,
      meta: this.#metadata,
      last: this.#buffer.contiguousSeq(),
    });
  };

  // ── Event handling ────────────────────────────────────────

  readonly #onEvent = (event: SocketEvent): void => {
    if (this.#disposed) return;
    switch (event.type) {
      case "open":
        this.#keepalive.start();
        return;
      case "message":
        this.#onMessage(event.data);
        return;
      case "refused":
        this.#onRefused(event.code, event.reason);
        return;
      case "closed":
        this.#keepalive.stop();
        if (this.#currentStatus() !== "blocked") {
          // A publish-capable connection can still speak over HTTP while the socket is
          // down; incoming lags until reconnect gap-fill heals it.
          this.#setStatus(this.#canPublish ? "degraded-http" : "reconnecting");
        }
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
    if (isActivity(frame)) return this.#onActivity(frame.userId, frame.kind, frame.since);
    if (isPresence(frame)) return this.#onPresence(frame);
    if (isReassign(frame)) {
      this.#leaf = frame.leaf;
      this.#socket?.reconnect();
      return;
    }
    // pong: keepalive, not modeled.
  }

  #onPresence(frame: PresenceFrame): void {
    this.#presence.applyDelta(frame);
    this.#publishState();
    const presence = this.#presence.current();
    if (presence !== undefined) this.events.emit("presence", presence);
  }

  #onReady(frame: ChannelReadyFrame): void {
    this.#leaf = frame.leaf;
    this.#bindings = frame.bindings;
    this.#canPublish = frame.me.capabilities.publish === true;
    this.#tokenRetryUsed = false;

    const heldBefore = this.#buffer.contiguousSeq();
    this.#buffer.setMe(frame.me.id, frame.me.anon);
    this.#buffer.setBaseline(frame.seq);
    // Watermark defaults to the head (nothing unread) when the server omits it.
    this.#buffer.setWatermark(frame.watermark ?? frame.seq);
    this.#presence.seed(frame.presence);

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
      // Replaced wholesale, never merged: a handle absent from this frame is a handle whose
      // extension is degraded or detached, and a stale blob would read as live state.
      ext: frame.ext,
      messages: this.#buffer.messages(),
      hasPrevious: this.#buffer.hasPrevious(),
      unread: this.#buffer.channelUnread(),
      presence: this.#presence.current(),
    }));
    const presence = this.#presence.current();
    if (presence !== undefined) this.events.emit("presence", presence);
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
      const credentials = this.#deps.credentials;
      if (credentials.managed) {
        // The SDK owns the credential: re-mint (same anonId) and retry rather than surfacing
        // a TokenExpiredError. Bounded to one re-mint between healthy sessions to avoid a
        // tight loop; a still-failing session keeps reconnecting with backoff.
        if (this.#tokenRetryUsed) {
          this.#setStatus("reconnecting");
          return;
        }
        this.#tokenRetryUsed = true;
        credentials.invalidate();
        this.#socket?.reconnect();
        return;
      }
      if (credentials.userStatic || this.#tokenRetryUsed) {
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
    // A thread reply is persistent by definition: the ephemeral lane has no thread field, so
    // anything that would travel on it is refused outright rather than losing its thread —
    // and an explicitly ephemeral send carrying a thread id is refused before routing, so no
    // transport binding can turn that contradiction into a persistent reply.
    const threadParentId = (input as { threadParentId?: string }).threadParentId;
    if (input.ephemeral === true && threadParentId !== undefined) {
      return Promise.reject(threadOnEphemeralLane(input.type));
    }
    const route = this.#extensionRoute(input.type);

    if (route !== undefined) {
      if (this.#degraded.has(route.namespace)) {
        return Promise.reject(
          new DegradedError(`The "${route.namespace}" extension is degraded.`),
        );
      }
      if (route.transport === "ws") {
        if (threadParentId !== undefined) return Promise.reject(threadOnEphemeralLane(input.type));
        return this.#sendEphemeralFrame(input.type, input.content);
      }
      // HTTP-routed extension sends publish with `threadParentId` in the body and, as for
      // every extension publish, without an optimistic insert; the reply reaches the thread
      // lens through the channel.
      return this.#publishOnce(input);
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
      threadParentId: persistent.threadParentId,
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

  // ── Read state ────────────────────────────────────────────

  /** Advance the channel watermark to the head, clearing `unread`. */
  markAsRead(): void {
    const head = this.#buffer.headSeq();
    if (head === undefined) return;
    this.#buffer.setWatermark(head);
    const frame: WatermarkFrame = { t: "watermark", seq: head };
    this.#socket?.send(serializeFrame(frame));
    this.#publishState();
  }

  // ── Activity ──────────────────────────────────────────────

  sendActivity(kind: string): void {
    // No roster on a broadcast channel — there is no one to signal.
    if (this.store.getSnapshot().info?.mode === "broadcast") return;
    const now = Date.now();
    const last = this.#activityThrottle.get(kind);
    if (last !== undefined && now - last < ACTIVITY_THROTTLE_MS) return;
    this.#activityThrottle.set(kind, now);
    const frame: ActivityUpFrame = { t: "activity", kind };
    this.#socket?.send(serializeFrame(frame));
  }

  #onActivity(userId: string, kind: string, since: number): void {
    const key = `${userId}:${kind}`;
    const existing = this.#activity.get(key);
    if (existing !== undefined) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.#activity.delete(key);
      this.#publishState();
      this.events.emit("activity", this.store.getSnapshot().activity);
    }, ACTIVITY_EXPIRY_MS);
    this.#activity.set(key, { entry: { userId, kind, since }, timer });
    this.#publishState();
    this.events.emit("activity", this.store.getSnapshot().activity);
  }

  #clearActivity(): void {
    for (const { timer } of this.#activity.values()) clearTimeout(timer);
    this.#activity.clear();
  }

  // ── Presence metadata ─────────────────────────────────────

  /** Replace this session's presence metadata; the server re-announces it via deltas. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.#metadata = metadata;
    const frame: MetaFrame = { t: "meta", metadata };
    this.#socket?.send(serializeFrame(frame));
  }

  // ── Members ───────────────────────────────────────────────

  /** Fetch the full member directory, following the pagination cursor. */
  async members(): Promise<MemberRow[]> {
    const rows: MemberRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#httpClient().members(this.#deps.channelId, cursor);
      rows.push(...page.members);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return rows;
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

  // ── Threads ───────────────────────────────────────────────

  #thread(threadId: string): ThreadState {
    let state = this.#threads.get(threadId);
    if (state === undefined) {
      state = { subscribers: 0, loaded: false, inFlight: undefined, loading: false };
      this.#threads.set(threadId, state);
    }
    return state;
  }

  /** One thread's replies, in order, own unacked replies appended. */
  threadMessages(threadId: string): Message[] {
    return this.#buffer.threadMessages(threadId);
  }

  threadHasPrevious(threadId: string): boolean {
    return this.#buffer.threadHasPrevious(threadId);
  }

  threadIsLoadingPrevious(threadId: string): boolean {
    return this.#threads.get(threadId)?.loading ?? false;
  }

  /**
   * A lens subscription: the channel store notifies it, and the first one this session
   * triggers the thread's initial page. The count is what a reconnect consults.
   */
  subscribeThread(threadId: string, listener: () => void): Unsubscribe {
    const state = this.#thread(threadId);
    state.subscribers++;
    this.#ensureThreadLoaded(threadId);
    const off = this.store.subscribe(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.subscribers--;
      off();
    };
  }

  /** Thread-scoped events: `message`/`mention`/`retract` narrowed; the rest are the channel's. */
  onThread<E extends keyof ChannelEvents<unknown>>(
    threadId: string,
    event: E,
    fn: ChannelEvents<unknown>[E],
  ): Unsubscribe {
    this.#ensureThreadLoaded(threadId);
    switch (event) {
      case "message": {
        const handler = fn as ChannelEvents<unknown>["message"];
        return this.events.on("message", (msg: Message) => {
          if (msg.threadParentId === threadId) handler(msg);
        });
      }
      case "mention": {
        const handler = fn as ChannelEvents<unknown>["mention"];
        return this.events.on("mention", (msg: Message) => {
          if (msg.threadParentId === threadId) handler(msg);
        });
      }
      case "retract": {

        const handler = fn as ChannelEvents<unknown>["retract"];
        return this.events.on("retract", (messageId: string) => {
          if (this.#buffer.threadOf(messageId) === threadId) handler(messageId);
        });
      }
      default:
        return this.events.on(event, fn);
    }
  }

  /** Older replies in one thread; see {@link ThreadHandle.loadPrevious}. */
  loadThreadPrevious(threadId: string): Promise<boolean> {
    const state = this.#thread(threadId);
    if (state.inFlight !== undefined) {
      if (!state.loading) {
        state.loading = true;
        this.#publishState();
      }
      return state.inFlight;
    }
    if (state.loaded && !this.#buffer.threadHasPrevious(threadId)) return Promise.resolve(false);
    return this.#fetchThread(threadId, true);
  }

  /** The thread registry — one page, with keyset `next()`. */
  threads(query: ThreadsQuery | undefined): Promise<ThreadPage> {
    return this.#threadPage(query, undefined);
  }

  #ensureThreadLoaded(threadId: string): void {
    const state = this.#thread(threadId);
    // Nothing to fetch against until the session exists; `connect()` picks subscribed threads up.
    if (state.loaded || this.#socket === undefined) return;
    this.#fetchThread(threadId, false).catch(() => {
      // Like the channel's own backfill: a failed initial page is retried by the next
      // subscription or `loadPrevious`, and there is nothing to surface meanwhile.
    });
  }

  /**
   * Fetch the page before the oldest reply held for a thread — or, holding none, the latest
   * page (the lazy initial fetch). `explicit` marks a caller-driven `loadPrevious`, which is
   * what the lens reports as loading; the automatic initial page is not.
   */
  #fetchThread(threadId: string, explicit: boolean): Promise<boolean> {
    const state = this.#thread(threadId);
    state.loaded = true;
    if (explicit) state.loading = true;
    const pageSize = this.#deps.history === "none" ? 50 : this.#deps.history;
    const before = this.#buffer.lowestThreadSeq(threadId);

    const promise = (async (): Promise<boolean> => {
      try {
        const page = await this.#httpClient().history(this.#deps.channelId, {
          threadParentId: threadId,
          ...(before !== undefined ? { before } : {}),
          limit: pageSize,
        });
        if (this.#disposed) return false;
        this.#buffer.ingestThreadHistory(page.msgs);
        this.#buffer.setThreadHasPrevious(threadId, page.hasMore);
        return page.hasMore;
      } catch (cause) {
        state.loaded = false;
        throw cause;
      } finally {
        state.loading = false;
        state.inFlight = undefined;
        if (!this.#disposed) this.#publishState();
      }
    })();
    state.inFlight = promise;
    if (explicit) this.#publishState();
    return promise;
  }

  async #threadPage(query: ThreadsQuery | undefined, before: number | undefined): Promise<ThreadPage> {
    const page = await this.#httpClient().threads(this.#deps.channelId, {
      ...(query?.root !== undefined ? { root: query.root } : { parent: query?.parent ?? "" }),
      ...(before !== undefined ? { before } : {}),
      ...(query?.limit !== undefined ? { limit: query.limit } : {}),
    });
    const last = page.threads.at(-1);
    return {
      threads: page.threads.map(toThreadNode),
      hasMore: page.hasMore,
      next: () =>
        page.hasMore && last !== undefined
          ? this.#threadPage(query, last.spawnSeq)
          : Promise.resolve(exhaustedThreadPage()),
    };
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
      ...(persistent.threadParentId !== undefined
        ? { threadParentId: persistent.threadParentId }
        : {}),
    };
  }

  #publishError(code: string, reason?: string): PortalError {
    if (code === "blocked_by_middleware") {
      return new BlockedError(reason ?? "The message was blocked.");
    }
    if (code === "validation_failed") {
      // `reason` is a machine-readable token here (e.g. `thread_depth_exceeded`), so the
      // human copy is derived rather than echoed.
      return new BlockedError(reason ?? "validation_failed", validationMessage(reason));
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
        httpUrl: this.#deps.hosts.realtimeHttpUrl,
        apiKey: this.#deps.apiKey,
        token: this.#deps.credentials.resolve,
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
      unread: this.#buffer.channelUnread(),
      activity: [...this.#activity.values()].map((a) => a.entry),
      presence: this.#presence.current(),
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
    this.#keepalive.stop();
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
