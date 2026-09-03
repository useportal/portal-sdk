import type { ChannelConnection } from "./connection.js";
import { NotYetSupportedError } from "./errors.js";
import type {
  ChannelEvents,
  ChannelSnapshot,
  ChannelView,
  Message,
  MessageWhere,
  SendAck,
  ThreadHandle,
  ThreadSendInput,
  ThreadSnapshot,
  Unsubscribe,
} from "./types.js";

/** Field-wise equality of two public messages — the buffer rebuilds objects on every publish. */
const sameMessage = (a: Message, b: Message): boolean =>
  a.id === b.id &&
  a.content === b.content &&
  a.retracted === b.retracted &&
  a.unread === b.unread &&
  a.status === b.status &&
  a.timestamp === b.timestamp &&
  a.type === b.type &&
  a.sender.id === b.sender.id &&
  a.sender.anon === b.sender.anon &&
  a.sender.username === b.sender.username &&
  a.to === b.to &&
  a.mentions === b.mentions &&
  a.threadParentId === b.threadParentId;

const sameSnapshot = (a: ThreadSnapshot, b: ThreadSnapshot): boolean =>
  a.isLoadingPrevious === b.isLoadingPrevious &&
  a.hasPrevious === b.hasPrevious &&
  a.messages.length === b.messages.length &&
  a.messages.every((m, i) => sameMessage(m, b.messages[i] as Message));

/**
 * A thread lens over a {@link ChannelConnection}. It holds no replies of its own: every read
 * is the channel buffer narrowed to `threadParentId === threadId`, memoised against the
 * channel snapshot so an unrelated channel change (another thread's reply, presence, typing)
 * hands back the same snapshot object and a `useSyncExternalStore` consumer does not
 * re-render.
 */
export class ThreadHandleImpl implements ThreadHandle<unknown> {
  readonly threadId: string;
  readonly #connection: ChannelConnection;
  #source: ChannelSnapshot | undefined;
  #derived: ThreadSnapshot | undefined;

  constructor(connection: ChannelConnection, threadId: string) {
    this.#connection = connection;
    this.threadId = threadId;
  }

  // ── Store contract ────────────────────────────────────────

  subscribe(listener: () => void): Unsubscribe {
    return this.#connection.subscribeThread(this.threadId, listener);
  }

  getSnapshot(): ThreadSnapshot<unknown> {
    const source = this.#connection.store.getSnapshot();
    if (source === this.#source && this.#derived !== undefined) return this.#derived;
    const next: ThreadSnapshot = {
      messages: this.#connection.threadMessages(this.threadId),
      isLoadingPrevious: this.#connection.threadIsLoadingPrevious(this.threadId),
      hasPrevious: this.#connection.threadHasPrevious(this.threadId),
    };
    this.#source = source;
    if (this.#derived === undefined || !sameSnapshot(this.#derived, next)) this.#derived = next;
    return this.#derived;
  }

  on<E extends keyof ChannelEvents<unknown>>(
    event: E,
    fn: ChannelEvents<unknown>[E],
  ): Unsubscribe {
    return this.#connection.onThread(this.threadId, event, fn);
  }

  // ── State reads ───────────────────────────────────────────

  get messages(): readonly Message<unknown>[] {
    return this.getSnapshot().messages;
  }
  get isLoadingPrevious(): boolean {
    return this.getSnapshot().isLoadingPrevious;
  }
  get hasPrevious(): boolean {
    return this.getSnapshot().hasPrevious;
  }

  /** Reserved, as on the channel: typed but rejected loudly, never silently ignored. */
  view(_where: MessageWhere<unknown>): ChannelView<unknown> {
    throw new NotYetSupportedError(
      "Filtering a thread with where() is reserved and not supported in v1.",
    );
  }

  // ── Write plane ───────────────────────────────────────────

  send(input: ThreadSendInput<unknown>): Promise<SendAck> {
    if ((input as { ephemeral?: boolean }).ephemeral === true) {
      return Promise.reject(
        new NotYetSupportedError("An ephemeral send cannot be addressed to a thread."),
      );
    }
    return this.#connection.send({ ...input, threadParentId: this.threadId });
  }

  loadPrevious(): Promise<boolean> {
    return this.#connection.loadThreadPrevious(this.threadId);
  }
}
