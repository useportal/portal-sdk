import { serializeFrame, type InboxEntryWire } from "@portalsdk/wire-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Portal, type InboxHandle } from "../src/index.js";
import { resetSocketFactory, setSocketFactory } from "../src/transport/factory.js";
import { MockSocketServer, type ConnectScript } from "./mock-server/index.js";

afterEach(() => {
  resetSocketFactory();
});

function setup(script: ConnectScript): { inbox: InboxHandle; server: MockSocketServer } {
  const server = new MockSocketServer(script);
  setSocketFactory(server.factory);
  const inbox = new Portal({ apiKey: "pk", token: "jwt" }).inbox();
  return { inbox, server };
}

const channelRow: InboxEntryWire = {
  id: "c1",
  latest: { text: "root msg", sender: { id: "u_a" }, at: 1 },
  unread: 1,
  muted: false,
  at: 1,
};
const rootRow: InboxEntryWire = {
  id: "c1",
  threadId: "m_1",
  rootThreadId: "m_1",
  latest: { text: "reply", sender: { id: "u_b" }, at: 2 },
  unread: 2,
  muted: false,
  at: 2,
};
const subRow: InboxEntryWire = {
  id: "c1",
  threadId: "m_2",
  parentThreadId: "m_1",
  rootThreadId: "m_1",
  latest: { text: "nested", sender: { id: "u_c" }, at: 3 },
  unread: 3,
  muted: false,
  at: 3,
};

const seeded: ConnectScript = (ctx) =>
  ctx.inboxReady({ entries: [channelRow, rootRow, subRow], counter: 6 });

const emitEntry = (server: MockSocketServer, entry: InboxEntryWire): void =>
  server.socket?.emit({ type: "message", data: serializeFrame({ t: "entry", entry }) });

describe("thread entries are siblings of the channel entry", () => {
  it("exposes all three with their pointers, and get(id, threadId) tells them apart", async () => {
    const { inbox } = setup(seeded);
    await vi.waitFor(() => expect(inbox.status).toBe("ready"));

    expect(inbox.channels).toHaveLength(3);
    expect(inbox.channels.get("c1")).toMatchObject({ id: "c1", unread: 1 });
    expect(inbox.channels.get("c1")).not.toHaveProperty("threadId");
    expect(inbox.channels.get("c1", "m_1")).toMatchObject({
      id: "c1",
      threadId: "m_1",
      rootThreadId: "m_1",
      unread: 2,
    });
    expect(inbox.channels.get("c1", "m_1")).not.toHaveProperty("parentThreadId");
    expect(inbox.channels.get("c1", "m_2")).toMatchObject({
      id: "c1",
      threadId: "m_2",
      parentThreadId: "m_1",
      rootThreadId: "m_1",
      unread: 3,
    });
    expect(inbox.channels.get("c1", "m_nope")).toBeUndefined();
  });

  it("applies a sub-thread entry upsert to that entry alone — no bubbling", async () => {
    const { inbox, server } = setup(seeded);
    await vi.waitFor(() => expect(inbox.status).toBe("ready"));

    emitEntry(server, {
      ...subRow,
      latest: { text: "another nested", sender: { id: "u_c" }, at: 4 },
      unread: 4,
      at: 4,
    });

    expect(inbox.channels.get("c1", "m_2")).toMatchObject({
      unread: 4,
      latest: { text: "another nested" },
    });
    expect(inbox.channels.get("c1", "m_1")).toMatchObject({ unread: 2, latest: { text: "reply" } });
    expect(inbox.channels.get("c1")).toMatchObject({ unread: 1, latest: { text: "root msg" } });
    expect(inbox.channels).toHaveLength(3);
    // Recency-sorted across siblings, like any other entries.
    expect(inbox.channels.map((e) => e.threadId)).toEqual(["m_2", "m_1", undefined]);
  });

  it("reads and mutes one entry, addressing the thread upstream", async () => {
    const { inbox, server } = setup(seeded);
    await vi.waitFor(() => expect(inbox.status).toBe("ready"));

    inbox.channels.get("c1", "m_2")?.markAsRead();
    expect(server.socket?.receivedInbox.find((f) => f?.t === "read")).toEqual({
      t: "read",
      channelId: "c1",
      threadId: "m_2",
    });
    expect(inbox.channels.get("c1", "m_2")?.unread).toBe(0);
    expect(inbox.channels.get("c1", "m_1")?.unread).toBe(2);
    expect(inbox.channels.get("c1")?.unread).toBe(1);

    inbox.channels.get("c1", "m_1")?.mute();
    expect(server.socket?.receivedInbox.find((f) => f?.t === "mute")).toEqual({
      t: "mute",
      channelId: "c1",
      muted: true,
      threadId: "m_1",
    });
    expect(inbox.channels.get("c1", "m_1")?.muted).toBe(true);
    expect(inbox.channels.get("c1")?.muted).toBe(false);
    expect(inbox.channels.get("c1", "m_2")?.muted).toBe(false);

    // The channel entry's own frames carry no threadId at all.
    inbox.channels.get("c1")?.markAsRead();
    expect(server.socket?.receivedInbox.filter((f) => f?.t === "read").at(-1)).toEqual({
      t: "read",
      channelId: "c1",
    });
  });

  it("keeps thread entries inside a channel-scoped view, with the full registry on get", async () => {
    const { inbox } = setup((ctx) =>
      ctx.inboxReady({
        entries: [channelRow, rootRow, { id: "c2", unread: 0, muted: false, at: 9 }],
        counter: 3,
      }),
    );
    await vi.waitFor(() => expect(inbox.status).toBe("ready"));

    const view = inbox.view({ channelId: "c1" });
    expect(view.channels.map((e) => [e.id, e.threadId])).toEqual([
      ["c1", "m_1"],
      ["c1", undefined],
    ]);
    expect(view.channels.get("c2")?.id).toBe("c2");
    expect(view.channels.get("c1", "m_1")?.threadId).toBe("m_1");
  });
});
