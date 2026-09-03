import type { Mention, WireMessage } from "./message.js";

/**
 * Body of `POST /v1/channels/{channelId}/messages` (§3.1).
 *
 * Persistent publishes go over HTTP, never the socket (§2.2).
 */
export type PublishBody = {
  /** Userland discriminator; defaults to `"message"`. */
  type?: string;
  /** ≤2KB, opaque. */
  content: unknown;
  /** Defaults to `"text"`. Media kinds are rejected in v1 (§7). */
  kind?: string;
  /**
   * Delivery instruction: skip fan-out and deliver to this member only, writing their
   * inbox item. A field named `to` inside `content` routes nothing.
   */
  to?: string;
  /** Declared by the sender; the platform verifies, dedupes, and caps them. */
  mentions?: Mention[];
  /**
   * Reply into a thread: the id of the message being replied to (the thread id). The first
   * reply to a message creates its thread. Nesting beyond the platform's depth cap is
   * rejected with `validation_failed` / `thread_depth_exceeded`.
   */
  threadParentId?: string;
};


/**
 * A successful publish (§3.1) — the wire form of the SendAck.
 *
 * Named `…Wire` deliberately: the SDK's *public* `SendAck` is `{ id, timestamp }` with
 * no `seq`, because `seq` is transport and gets stripped at the SDK edge. Same concept,
 * different layer — do not treat the two as interchangeable.
 *
 * An ack means accepted and durable; it does not mean permanent (a retraction may
 * follow).
 */
export type SendAckWire = {
  id: string;
  seq: number;
  timestamp: number;
};

/**
 * `GET /v1/channels/{channelId}/history` (§3.2).
 *
 * One endpoint serves initial backfill, scroll-up paging (`?before=&limit=`), gap-fill
 * ranges (`?from=&to=`), and thread paging (`?threadParentId=&before=&limit=`, where
 * `before` is a `threadSeq`). Retracted messages come back as tombstoned envelopes,
 * consistent with live rendering.
 */
export type HistoryResponse = {
  msgs: WireMessage[];
  hasMore: boolean;
};

/**
 * One thread in a channel's thread registry, as returned by
 * `GET /v1/channels/{channelId}/threads`.
 */
export type ThreadNodeWire = {
  /** The thread id — the id of the message whose first reply created it. */
  id: string;
  /** The enclosing thread; absent on a root thread. */
  parentThreadId?: string;
  /** The top-level ancestor; equals `id` on a root thread. */
  rootThreadId: string;
  /** Nesting level; a root thread is depth `0`. */
  depth: number;
  /** Channel `seq` of the message this thread hangs off. */
  spawnSeq: number;
  /** Who sent the message this thread hangs off. */
  spawnedBy: { id: string };
  /** Channel `seq` of the most recent reply. */
  latestSeq: number;
  /** Highest `threadSeq` in the thread — the reply count. */
  threadSeq: number;
  /** Epoch milliseconds. */
  createdAt: number;
};

/**
 * `GET /v1/channels/{channelId}/threads?parent={id|""}|root={id}&before=&limit=`.
 *
 * `parent=""` lists root threads; `parent={id}` lists the threads nested directly under
 * one; `root={id}` lists every thread descending from a root.
 */
export type ThreadsResponse = {
  threads: ThreadNodeWire[];
  hasMore: boolean;
};


/** One row of the member directory (§3.3). */
export type MemberRow = {
  userId: string;
  online: boolean;
  claims: Record<string, unknown>;
};

/**
 * `GET /v1/channels/{channelId}/members` (§3.3). Standard channels only.
 *
 * A fetched directory including offline members — not live presence state. `cursor` is
 * absent on the last page.
 */
export type MembersResponse = {
  members: MemberRow[];
  cursor?: string;
};
