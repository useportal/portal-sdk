import { ChannelConnection } from "./connection.js";
import type { ResolvedHosts } from "./config.js";
import { devWarn } from "./env.js";
import { NotYetSupportedError } from "./errors.js";
import type { TokenSource } from "./token.js";
import type {
  ChannelEvents,
  ChannelHandle,
  ChannelInfo,
  ChannelOptions,
  ChannelSnapshot,
  ChannelStatus,
  ChannelView,
  MemberRow,
  Message,
  MessageWhere,
  SendAck,
  SendInput,
  Unsubscribe,
} from "./types.js";

/** Grace window between the last `release()` and teardown (~seconds). */
export const GRACE_MS = 3_000;

export interface ChannelHandleDeps {
  channelId: string;
  hosts: ResolvedHosts;
  apiKey: string;
  token: TokenSource;
  options: ChannelOptions | undefined;
}

/** A mutable cell the leak registry inspects after a handle is collected. */
interface LeakCell {
  channelId: string;
  count: number;
}

const leakRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<LeakCell>((cell) => {
        if (cell.count > 0) {
          devWarn(
            `channel "${cell.channelId}" was garbage-collected with ${cell.count} ` +
              `outstanding acquire(s) — every acquire() needs a matching release()`,
          );
        }
      })
    : undefined;

/**
 * The refcounting shell over a {@link ChannelConnection}. N views of a channel share one
 * socket: the first `acquire()` connects, and the last `release()` tears down after a
 * grace window that absorbs React StrictMode remounts and quick navigation. Reads and the
 * store contract delegate straight to the connection.
 */
export class ChannelHandleImpl implements ChannelHandle<unknown> {
  readonly #connection: ChannelConnection;
  readonly #leak: LeakCell;
  #count = 0;
  #active = false;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ChannelHandleDeps) {
    this.#connection = new ChannelConnection({
      channelId: deps.channelId,
      hosts: deps.hosts,
      apiKey: deps.apiKey,
      token: deps.token,
      metadata: deps.options?.metadata,
    });
    this.#leak = { channelId: deps.channelId, count: 0 };
    leakRegistry?.register(this, this.#leak);
  }

  // ── Refcounted lifecycle ──────────────────────────────────

  acquire(): void {
    this.#count++;
    this.#leak.count = this.#count;
    if (this.#graceTimer !== undefined) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = undefined;
    }
    if (!this.#active) {
      this.#active = true;
      this.#connection.connect();
    }
  }

  release(): void {
    if (this.#count === 0) return;
    this.#count--;
    this.#leak.count = this.#count;
    if (this.#count === 0) {
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = undefined;
        this.#active = false;
        this.#connection.teardown();
      }, GRACE_MS);
    }
  }

  [Symbol.dispose](): void {
    this.release();
  }

  // ── Store contract ────────────────────────────────────────

  subscribe(listener: () => void): Unsubscribe {
    return this.#connection.store.subscribe(listener);
  }

  getSnapshot(): ChannelSnapshot<unknown> {
    return this.#connection.store.getSnapshot();
  }

  on<E extends keyof ChannelEvents<unknown>>(
    event: E,
    fn: ChannelEvents<unknown>[E],
  ): Unsubscribe {
    return this.#connection.events.on(event, fn);
  }

  // ── State reads (delegate to the connection snapshot) ─────

  get messages(): readonly Message<unknown>[] {
    return this.getSnapshot().messages;
  }
  get presence(): ChannelSnapshot["presence"] {
    return this.getSnapshot().presence;
  }
  get activity(): ChannelSnapshot["activity"] {
    return this.getSnapshot().activity;
  }
  get typing(): readonly string[] {
    return this.getSnapshot()
      .activity.filter((a) => a.kind === "typing")
      .map((a) => a.userId);
  }
  get unread(): number {
    return this.getSnapshot().unread;
  }
  get status(): ChannelStatus {
    return this.getSnapshot().status;
  }
  get info(): ChannelInfo | undefined {
    return this.getSnapshot().info;
  }
  get me(): ChannelSnapshot["me"] {
    return this.getSnapshot().me;
  }
  get isLoadingPrevious(): boolean {
    return this.getSnapshot().isLoadingPrevious;
  }
  get hasPrevious(): boolean {
    return this.getSnapshot().hasPrevious;
  }

  /**
   * A filtered channel view is a reserved surface in v1 — the `where` grammar is typed but
   * rejected loudly (§6), never silently ignored.
   */
  view(_where: MessageWhere<unknown>): ChannelView<unknown> {
    throw new NotYetSupportedError(
      "Filtering a channel with where() is reserved and not supported in v1.",
    );
  }

  // ── Write plane ───────────────────────────────────────────

  send(_input: SendInput<unknown>): Promise<SendAck> {
    return Promise.reject(new Error("send() is not implemented."));
  }
  loadPrevious(): Promise<boolean> {
    return Promise.reject(new Error("loadPrevious() is not implemented."));
  }
  sendActivity(_kind: string): void {
    throw new Error("sendActivity() is not implemented.");
  }
  sendTyping(): void {
    throw new Error("sendTyping() is not implemented.");
  }
  markAsRead(): void {
    throw new Error("markAsRead() is not implemented.");
  }
  setMetadata(_metadata: Record<string, unknown>): void {
    throw new Error("setMetadata() is not implemented.");
  }
  members(): Promise<MemberRow[]> {
    return Promise.reject(new Error("members() is not implemented."));
  }
}
