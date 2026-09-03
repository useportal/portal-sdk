import { serializeFrame, type WireMessage } from "@portalsdk/wire-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRACE_MS } from "../src/channel.js";
import {
  BlockedError,
  NotYetSupportedError,
  Portal,
  type ChannelHandle,
  type ChannelOptions,
} from "../src/index.js";
import { resetHttpClientFactory, setHttpClientFactory } from "../src/http/factory.js";
import { resetSocketFactory, setSocketFactory } from "../src/transport/factory.js";
import { MockHttpClient } from "./mock-server/http.js";
import { MockSocketServer, type ConnectScript } from "./mock-server/index.js";

afterEach(() => {
  resetSocketFactory();
  resetHttpClientFactory();
  vi.useRealTimers();
});

function msg(seq: number, over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: `m_${seq}`,
    seq,
    type: "message",
    kind: "text",
    content: { text: `msg ${seq}` },
    sender: { id: "u_other", anon: false },
    timestamp: 1_000 + seq,
    retracted: false,
    ephemeral: false,
    ...over,
  };
}

/** A reply at channel `seq`, the `threadSeq`-th reply in thread `parent`. */
const reply = (seq: number, parent: string, threadSeq: number, over: Partial<WireMessage> = {}) =>
  msg(seq, { threadParentId: parent, threadSeq, ...over });

function setup(
  script: ConnectScript,
  http: MockHttpClient = new MockHttpClient(),
  options?: ChannelOptions,
): { channel: ChannelHandle; server: MockSocketServer; http: MockHttpClient } {
  const server = new MockSocketServer(script);
  setSocketFactory(server.factory);
  setHttpClientFactory(http.factory);
  const channel = new Portal({ apiKey: "pk", token: "jwt" }).channel("room", options);
  channel.acquire();
  return { channel, server, http };
}

const ids = (list: readonly { id: string }[]): string[] => list.map((m) => m.id);

describe("thread lenses over the channel store", () => {
  it("lands a live reply in the channel and in its own thread lens only", async () => {
    const { channel } = setup((ctx) => {
      ctx.ready({ seq: 1 });
      ctx.send({ t: "batch", msgs: [reply(2, "m_1", 1)] });
    });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));

    expect(channel.messages[0]).toMatchObject({ id: "m_2", threadParentId: "m_1" });
    expect(ids(channel.thread("m_1").messages)).toEqual(["m_2"]);
    expect(channel.thread("m_other").messages).toHaveLength(0);
  });

  it("keeps a depth-2 reply out of the root thread's lens", async () => {
    const { channel } = setup((ctx) => {
      ctx.ready({ seq: 1 });
      ctx.send({ t: "batch", msgs: [reply(2, "m_1", 1), reply(3, "m_2", 1)] });
    });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));

    expect(ids(channel.thread("m_1").messages)).toEqual(["m_2"]);
    expect(ids(channel.thread("m_2").messages)).toEqual(["m_3"]);
    // Both are still channel messages — the channel carries replies at every depth.
    expect(ids(channel.messages)).toEqual(["m_2", "m_3"]);
  });

  it("returns the same lens object for the same thread id", async () => {
    const { channel } = setup((ctx) => ctx.ready());
    expect(channel.thread("m_1")).toBe(channel.thread("m_1"));
    expect(channel.thread("m_1")).not.toBe(channel.thread("m_2"));
    expect(channel.thread("m_1").threadId).toBe("m_1");
  });

  it("reflects a retraction inside the thread lens, and narrows the retract event", async () => {
    const retracted: string[] = [];
    const otherRetracted: string[] = [];
    const { channel, server } = setup((ctx) => {
      ctx.ready({ seq: 1 });
      ctx.send({ t: "batch", msgs: [reply(2, "m_1", 1), reply(3, "m_9", 1)] });
    });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
    channel.thread("m_1").on("retract", (id) => retracted.push(id));
    channel.thread("m_9").on("retract", (id) => otherRetracted.push(id));

    server.socket?.emit({
      type: "message",
      data: serializeFrame({ t: "retract", id: "m_2", seq: 2 }),
    });

    expect(channel.thread("m_1").messages[0]?.retracted).toBe(true);
    expect(retracted).toEqual(["m_2"]);
    expect(otherRetracted).toEqual([]);
  });
});

describe("lazy initial fetch", () => {
  it("fetches nothing until the first subscription, then the thread's latest page once", async () => {
    const http = new MockHttpClient({
      onHistory: (_c, q) =>
        q.threadParentId === "m_1"
          ? { msgs: [reply(4, "m_1", 1), reply(6, "m_1", 2)], hasMore: false }
          : { msgs: [], hasMore: false },
    });
    const { channel } = setup((ctx) => ctx.ready({ seq: 10 }), http, { history: "none" });
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    const thread = channel.thread("m_1");
    expect(http.historyCalls).toHaveLength(0);
    expect(thread.messages).toHaveLength(0);

    const offA = thread.subscribe(() => {});
    expect(http.historyCalls).toEqual([
      { channelId: "room", query: { threadParentId: "m_1", limit: 50 } },
    ]);
    await vi.waitFor(() => expect(thread.messages).toHaveLength(2));
    expect(ids(thread.messages)).toEqual(["m_4", "m_6"]);
    expect(thread.hasPrevious).toBe(false);

    const offB = thread.subscribe(() => {});
    expect(http.historyCalls).toHaveLength(1);
    offA();
    offB();
  });

  it("uses the channel's history size as the thread page size", async () => {
    const { channel, http } = setup((ctx) => ctx.ready(), undefined, { history: 7 });
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    channel.thread("m_1").subscribe(() => {});
    expect(http.historyCalls.at(-1)?.query).toEqual({ threadParentId: "m_1", limit: 7 });
  });

  it("keeps thread-page replies older than the channel's own page out of channel.messages and its cursor", async () => {
    const http = new MockHttpClient({
      onHistory: (_c, q) => {
        if (q.threadParentId === "m_1") return { msgs: [reply(3, "m_1", 1)], hasMore: false };
        if (q.before === undefined) return { msgs: [msg(8), msg(9), msg(10)], hasMore: true };
        if (q.before === 8) return { msgs: [msg(5), msg(6), msg(7)], hasMore: false };
        return { msgs: [], hasMore: false };
      },
    });
    const { channel } = setup((ctx) => ctx.ready({ seq: 10 }), http);
    await vi.waitFor(() => expect(channel.messages).toHaveLength(3));

    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    await vi.waitFor(() => expect(thread.messages).toHaveLength(1));

    // The reply is the thread's, not the channel's: the channel view starts where its own
    // page did, and its next older page is asked for from there.
    expect(ids(channel.messages)).toEqual(["m_8", "m_9", "m_10"]);
    await channel.loadPrevious();
    expect(http.historyCalls.find((c) => c.query.before !== undefined)?.query).toEqual({
      before: 8,
      limit: 50,
    });
    expect(ids(channel.messages)).toEqual(["m_5", "m_6", "m_7", "m_8", "m_9", "m_10"]);
  });

  it("re-fetches a subscribed thread when the channel reconnects after a teardown", async () => {
    vi.useFakeTimers();
    const { channel, http } = setup((ctx) => ctx.ready());
    await vi.advanceTimersByTimeAsync(0);

    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    expect(http.historyCalls.filter((c) => c.query.threadParentId === "m_1")).toHaveLength(1);

    channel.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    channel.acquire();
    await vi.advanceTimersByTimeAsync(0);

    expect(http.historyCalls.filter((c) => c.query.threadParentId === "m_1")).toHaveLength(2);
  });

  it("retries a failed initial page on the next subscription", async () => {
    let fail = true;
    const http = new MockHttpClient();
    http.history = (channelId, query) => {
      http.historyCalls.push({ channelId, query });
      if (fail) return Promise.reject(new Error("offline"));
      return Promise.resolve({ msgs: [reply(2, "m_1", 1)], hasMore: false });
    };
    const { channel } = setup((ctx) => ctx.ready(), http, { history: "none" });
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    await vi.waitFor(() => expect(http.historyCalls).toHaveLength(1));
    expect(thread.messages).toHaveLength(0);

    fail = false;
    thread.subscribe(() => {});
    await vi.waitFor(() => expect(thread.messages).toHaveLength(1));
  });
});

describe("thread loadPrevious", () => {
  /** Thread m_1 holds replies at thread positions 1–4 (channel seqs 10–40), two per page. */
  const pages = (): MockHttpClient =>
    new MockHttpClient({
      onHistory: (_c, q) => {
        if (q.threadParentId !== "m_1") return { msgs: [], hasMore: false };
        const all = [reply(10, "m_1", 1), reply(20, "m_1", 2), reply(30, "m_1", 3), reply(40, "m_1", 4)];
        const older = all.filter((m) => q.before === undefined || (m.threadSeq as number) < q.before);
        const page = older.slice(-2);
        return { msgs: page, hasMore: older.length > page.length };
      },
    });

  it("prepends only this thread's older replies and resolves false at the thread's start", async () => {
    const { channel, http } = setup((ctx) => {
      ctx.ready({ seq: 50 });
      ctx.send({ t: "batch", msgs: [reply(51, "m_1", 5), reply(52, "m_2", 1)] });
    }, pages(), { history: "none" });

    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));

    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    // The live reply is already held, so the initial page is the one just before it.
    expect(http.historyCalls.at(-1)?.query).toEqual({ threadParentId: "m_1", before: 5, limit: 50 });
    await vi.waitFor(() => expect(thread.messages).toHaveLength(3));
    expect(ids(thread.messages)).toEqual(["m_30", "m_40", "m_51"]);
    expect(thread.hasPrevious).toBe(true);


    const more = await thread.loadPrevious();
    expect(more).toBe(false);
    expect(thread.hasPrevious).toBe(false);
    expect(ids(thread.messages)).toEqual(["m_10", "m_20", "m_30", "m_40", "m_51"]);
    // The cursor is the thread's own position, not a channel seq.
    expect(http.historyCalls.at(-1)?.query).toEqual({ threadParentId: "m_1", before: 3, limit: 50 });
    // The sibling thread and the channel view are untouched.
    expect(ids(channel.thread("m_2").messages)).toEqual(["m_52"]);
    expect(ids(channel.messages)).toEqual(["m_51", "m_52"]);

    // At the start: no request, immediate false.
    const calls = http.historyCalls.length;
    expect(await thread.loadPrevious()).toBe(false);
    expect(http.historyCalls).toHaveLength(calls);
  });

  it("shares one in-flight promise and reports isLoadingPrevious", async () => {
    const { channel } = setup((ctx) => ctx.ready({ seq: 50 }), pages(), { history: "none" });

    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    await vi.waitFor(() => expect(thread.messages).toHaveLength(2));

    const first = thread.loadPrevious();
    const second = thread.loadPrevious();
    expect(first).toBe(second);
    expect(thread.isLoadingPrevious).toBe(true);
    await first;
    expect(thread.isLoadingPrevious).toBe(false);
  });

  it("acts as the initial fetch when called before any subscription", async () => {
    const { channel, http } = setup((ctx) => ctx.ready({ seq: 50 }), pages(), { history: "none" });

    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    const thread = channel.thread("m_1");
    expect(await thread.loadPrevious()).toBe(true);
    expect(ids(thread.messages)).toEqual(["m_30", "m_40"]);
    expect(http.historyCalls).toHaveLength(1);
  });
});

describe("sending into a thread", () => {
  it("sets threadParentId on the publish and echoes through optimistic insert + ack, never the wire", async () => {
    const http = new MockHttpClient({
      onPublish: () => ({ ok: true, ack: { id: "m_srv", seq: 2, timestamp: 999 } }),
    });
    const { channel, server } = setup((ctx) => ctx.ready({ seq: 1 }), http);
    await vi.waitFor(() => expect(channel.status).toBe("ready"));
    const thread = channel.thread("m_1");

    const pending = thread.send({ content: { text: "reply" } });
    expect(thread.messages.at(-1)).toMatchObject({ status: "pending", threadParentId: "m_1" });
    expect(channel.thread("m_other").messages).toHaveLength(0);

    await pending;
    expect(http.publishCalls[0]?.body).toMatchObject({ content: { text: "reply" }, threadParentId: "m_1" });
    expect(ids(thread.messages)).toEqual(["m_srv"]);
    expect(thread.messages[0]).toMatchObject({ status: "sent", threadParentId: "m_1" });
    expect(channel.messages[0]).toMatchObject({ id: "m_srv", threadParentId: "m_1" });

    // The wire echo of the own reply is a dup; the thread still holds exactly one copy.
    server.socket?.emit({
      type: "message",
      data: serializeFrame({ t: "batch", msgs: [reply(2, "m_1", 1, { id: "m_srv" })] }),
    });
    expect(ids(thread.messages)).toEqual(["m_srv"]);
    expect(ids(channel.messages)).toEqual(["m_srv"]);
  });

  it("also accepts threadParentId on channel.send", async () => {
    const { channel, http } = setup((ctx) => ctx.ready({ seq: 1 }));
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    await channel.send({ content: { text: "x" }, threadParentId: "m_1" });
    expect(http.publishCalls[0]?.body.threadParentId).toBe("m_1");
  });

  it("surfaces thread_depth_exceeded as a BlockedError with that reason and rolls back", async () => {
    const http = new MockHttpClient({
      onPublish: () => ({ ok: false, code: "validation_failed", reason: "thread_depth_exceeded" }),
    });
    const { channel } = setup((ctx) => ctx.ready({ seq: 1 }), http);
    await vi.waitFor(() => expect(channel.status).toBe("ready"));
    const thread = channel.thread("m_deep");

    const rejection = thread.send({ content: { text: "too deep" } });
    await expect(rejection).rejects.toBeInstanceOf(BlockedError);
    await rejection.catch((error: BlockedError) => {
      expect(error.reason).toBe("thread_depth_exceeded");
      expect(error.code).toBe("blocked");
    });
    expect(thread.messages).toHaveLength(0);
    expect(channel.messages).toHaveLength(0);
  });

  it("refuses a type bound to an extension's ephemeral transport, from both entry points", async () => {
    const { channel, server } = setup((ctx) => ctx.ready({ bindings: { "ns1.": "ws" } }));
    await vi.waitFor(() => expect(channel.status).toBe("ready"));
    const framesBefore = server.socket?.sent.length;

    await expect(
      channel.thread("m_1").send({ type: "ns1.move", content: { at: 3 } }),
    ).rejects.toBeInstanceOf(NotYetSupportedError);
    await expect(
      channel.send({ type: "ns1.move", content: { at: 3 }, threadParentId: "m_1" }),
    ).rejects.toBeInstanceOf(NotYetSupportedError);

    // Nothing left the client, and the same type without a thread still routes as before.
    expect(server.socket?.sent.length).toBe(framesBefore);
    await channel.send({ type: "ns1.move", content: { at: 3 } });
    expect(server.socket?.received.at(-1)).toMatchObject({ t: "ephemeral", type: "ns1.move" });
    expect(channel.thread("m_1").messages).toHaveLength(0);
  });

  it("publishes a type bound to an extension's HTTP transport with the thread id, no optimistic insert", async () => {
    const http = new MockHttpClient({
      onPublish: () => ({ ok: true, ack: { id: "e_1", seq: 2, timestamp: 0 } }),
    });
    const { channel, server } = setup((ctx) => ctx.ready({ seq: 1, bindings: { "ns2.": "http" } }), http);
    await vi.waitFor(() => expect(channel.status).toBe("ready"));
    const thread = channel.thread("m_1");

    const pending = thread.send({ type: "ns2.do", content: { go: true } });
    expect(thread.messages).toHaveLength(0);
    await pending;
    expect(http.publishCalls.at(-1)?.body).toMatchObject({ type: "ns2.do", threadParentId: "m_1" });

    // The reply reaches the thread lens through the channel, like every extension publish.
    server.socket?.emit({
      type: "message",
      data: serializeFrame({ t: "batch", msgs: [reply(2, "m_1", 1, { id: "e_1", type: "ns2.do" })] }),
    });
    expect(ids(thread.messages)).toEqual(["e_1"]);
  });

  it("rejects an ephemeral send addressed to a thread, whatever its type is bound to", async () => {
    const { channel, http, server } = setup((ctx) =>
      ctx.ready({ bindings: { "ns2.": "http", "ns1.": "ws" } }),
    );
    await vi.waitFor(() => expect(channel.status).toBe("ready"));
    const framesBefore = server.socket?.sent.length;

    for (const type of [undefined, "ns2.do", "ns1.move"]) {
      await expect(
        channel.thread("m_1").send({ ephemeral: true, type, content: {} } as never),
      ).rejects.toBeInstanceOf(NotYetSupportedError);
      await expect(
        channel.send({ ephemeral: true, type, content: {}, threadParentId: "m_1" } as never),
      ).rejects.toBeInstanceOf(NotYetSupportedError);
    }
    // Neither a persistent publish nor an ephemeral frame left the client.
    expect(http.publishCalls).toHaveLength(0);
    expect(server.socket?.sent.length).toBe(framesBefore);
  });
});

describe("thread events and snapshots", () => {
  it("narrows message and mention events to the thread", async () => {
    const messages: string[] = [];
    const mentions: string[] = [];
    const { channel } = setup((ctx) => {
      ctx.ready({ seq: 1, me: { id: "u_me", anon: false, claims: {}, capabilities: {} } });
      ctx.send({
        t: "batch",
        msgs: [
          reply(2, "m_1", 1, { mentions: [{ userId: "u_me" }] }),
          reply(3, "m_9", 1, { mentions: [{ userId: "u_me" }] }),
          msg(4),
        ],
      });
    });
    channel.thread("m_1").on("message", (m) => messages.push(m.id));
    channel.thread("m_1").on("mention", (m) => mentions.push(m.id));
    await vi.waitFor(() => expect(channel.messages).toHaveLength(3));

    expect(messages).toEqual(["m_2"]);
    expect(mentions).toEqual(["m_2"]);
  });

  it("hands back the same snapshot when only another thread changed", async () => {
    const { channel, server } = setup((ctx) => {
      ctx.ready({ seq: 1 });
      ctx.send({ t: "batch", msgs: [reply(2, "m_1", 1)] });
    });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    const thread = channel.thread("m_1");
    thread.subscribe(() => {});
    await vi.waitFor(() => expect(thread.messages).toHaveLength(1));
    const before = thread.getSnapshot();

    server.socket?.emit({
      type: "message",
      data: serializeFrame({ t: "batch", msgs: [reply(3, "m_other", 1)] }),
    });
    expect(channel.messages).toHaveLength(2);
    expect(thread.getSnapshot()).toBe(before);

    server.socket?.emit({
      type: "message",
      data: serializeFrame({ t: "batch", msgs: [reply(4, "m_1", 2)] }),
    });
    expect(thread.getSnapshot()).not.toBe(before);
    expect(ids(thread.getSnapshot().messages)).toEqual(["m_2", "m_4"]);
  });

  it("throws NotYetSupportedError for a thread where-view", async () => {
    const { channel } = setup((ctx) => ctx.ready());
    expect(() => channel.thread("m_1").view({ retracted: { eq: false } })).toThrow(
      NotYetSupportedError,
    );
  });
});

describe("threads registry", () => {
  const node = (id: string, spawnSeq: number, over: Record<string, unknown> = {}) => ({
    id,
    rootThreadId: id,
    depth: 0,
    spawnSeq,
    spawnedBy: { id: "u_1" },
    latestSeq: spawnSeq + 5,
    threadSeq: 5,
    createdAt: 1_000 + spawnSeq,
    ...over,
  });

  it("lists root threads by default and pages with next()", async () => {
    const http = new MockHttpClient({
      onThreads: (_c, q) =>
        q.before === undefined
          ? { threads: [node("m_20", 20), node("m_10", 10)], hasMore: true }
          : { threads: [node("m_5", 5)], hasMore: false },
    });
    const { channel } = setup((ctx) => ctx.ready(), http);

    const page = await channel.threads();
    expect(http.threadCalls[0]).toEqual({ channelId: "room", query: { parent: "" } });
    expect(page.hasMore).toBe(true);
    expect(page.threads).toEqual([
      { id: "m_20", rootThreadId: "m_20", depth: 0, spawnedBy: { id: "u_1" }, messageCount: 5, createdAt: 1_020 },
      { id: "m_10", rootThreadId: "m_10", depth: 0, spawnedBy: { id: "u_1" }, messageCount: 5, createdAt: 1_010 },
    ]);
    expect(page.threads[0]).not.toHaveProperty("spawnSeq");
    expect(page.threads[0]).not.toHaveProperty("latestSeq");

    const next = await page.next();
    expect(http.threadCalls[1]?.query).toEqual({ parent: "", before: 10 });
    expect(next.threads.map((t) => t.id)).toEqual(["m_5"]);
    expect(next.hasMore).toBe(false);

    const exhausted = await next.next();
    expect(exhausted).toMatchObject({ threads: [], hasMore: false });
    expect(http.threadCalls).toHaveLength(2);
  });

  it("sends parent, root, and limit as given", async () => {
    const http = new MockHttpClient({
      onThreads: () => ({
        threads: [node("m_2", 2, { parentThreadId: "m_1", rootThreadId: "m_1", depth: 1 })],
        hasMore: false,
      }),
    });
    const { channel } = setup((ctx) => ctx.ready(), http);

    await channel.threads({ parent: null, limit: 3 });
    await channel.threads({ parent: "m_1" });
    const byRoot = await channel.threads({ root: "m_1" });
    expect(http.threadCalls.map((c) => c.query)).toEqual([
      { parent: "", limit: 3 },
      { parent: "m_1" },
      { root: "m_1" },
    ]);
    expect(byRoot.threads[0]).toMatchObject({ id: "m_2", parentThreadId: "m_1", depth: 1 });
  });
});
