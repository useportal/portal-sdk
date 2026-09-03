import { describe, expect, it } from "vitest";

import {
  isBatch,
  isInboxEntry,
  isKnownChannelFrame,
  isKnownInboxClientFrame,
  isKnownInboxFrame,
  parseChannelFrame,
  parseInboxClientFrame,
  parseInboxFrame,
  serializeFrame,
  type InboxClientFrame,
  type InboxEntryWire,
  type PublishBody,
  type PublishErrorBody,
  type ThreadNodeWire,
  type ThreadsResponse,
  type WireMessage,
} from "./index.js";

const root: WireMessage = {
  id: "m_root",
  seq: 100,
  type: "message",
  kind: "text",
  content: { text: "root" },
  sender: { id: "u_1", anon: false },
  timestamp: 1751980000000,
  retracted: false,
  ephemeral: false,
};

const reply: WireMessage = {
  ...root,
  id: "m_reply",
  seq: 101,
  content: { text: "reply" },
  threadParentId: "m_root",
  threadSeq: 1,
};

const nested: WireMessage = {
  ...root,
  id: "m_nested",
  seq: 102,
  content: { text: "nested" },
  threadParentId: "m_reply",
  threadSeq: 1,
};

describe("threaded messages on the channel socket", () => {
  it("round-trips a batch mixing root, reply, and nested reply", () => {
    const frame = { t: "batch" as const, msgs: [root, reply, nested] };
    const parsed = parseChannelFrame(serializeFrame(frame));

    expect(parsed).toStrictEqual(frame);
    expect(parsed !== null && isKnownChannelFrame(parsed)).toBe(true);
    expect(parsed !== null && isBatch(parsed) && parsed.msgs[1]?.threadParentId).toBe("m_root");
    expect(parsed !== null && isBatch(parsed) && parsed.msgs[2]?.threadParentId).toBe("m_reply");
  });

  it("leaves a message without thread fields byte-for-byte unchanged", () => {
    const raw = serializeFrame({ t: "batch", msgs: [root] });
    const parsed = parseChannelFrame(raw);

    expect(parsed !== null && serializeFrame(parsed)).toBe(raw);
    expect(parsed !== null && isBatch(parsed) && "threadParentId" in parsed.msgs[0]!).toBe(false);
  });

  it("accepts a reply carrying threadParentId without threadSeq", () => {
    const { threadSeq: _omitted, ...withoutSeq } = reply;
    const parsed = parseChannelFrame(serializeFrame({ t: "batch", msgs: [withoutSeq] }));
    expect(parsed).not.toBeNull();
  });

  it.each([
    { ...reply, threadParentId: 7 },
    { ...reply, threadSeq: "1" },
    { ...reply, threadParentId: null },
  ])("rejects a reply whose thread fields have the wrong type", (msg) => {
    expect(parseChannelFrame(JSON.stringify({ t: "batch", msgs: [msg] }))).toBeNull();
  });

  it("delivers a threaded reply on a direct frame too", () => {
    const frame = { t: "direct" as const, msg: reply };
    expect(parseChannelFrame(serializeFrame(frame))).toStrictEqual(frame);
  });
});

describe("thread rows on the inbox socket", () => {
  const channelRow: InboxEntryWire = { id: "room-7", unread: 2, muted: false, at: 10 };
  const rootRow: InboxEntryWire = {
    id: "room-7",
    threadId: "m_root",
    rootThreadId: "m_root",
    latest: { text: "reply", sender: { id: "u_1" }, at: 11 },
    unread: 1,
    muted: false,
    at: 11,
  };
  const nestedRow: InboxEntryWire = {
    id: "room-7",
    threadId: "m_reply",
    parentThreadId: "m_root",
    rootThreadId: "m_root",
    unread: 1,
    muted: true,
    at: 12,
  };

  it("round-trips a ready carrying a channel row and its thread-row siblings", () => {
    const frame = {
      t: "ready" as const,
      entries: [channelRow, rootRow, nestedRow],
      items: [],
      counter: 4,
    };
    const parsed = parseInboxFrame(serializeFrame(frame));

    expect(parsed).toStrictEqual(frame);
    expect(parsed !== null && isKnownInboxFrame(parsed)).toBe(true);
  });

  it("round-trips an entry upsert for a nested thread row", () => {
    const frame = { t: "entry" as const, entry: nestedRow };
    const parsed = parseInboxFrame(serializeFrame(frame));

    expect(parsed).toStrictEqual(frame);
    expect(parsed !== null && isInboxEntry(parsed) && parsed.entry.parentThreadId).toBe("m_root");
  });

  it("leaves a channel row without pointers byte-for-byte unchanged", () => {
    const raw = serializeFrame({ t: "entry", entry: channelRow });
    const parsed = parseInboxFrame(raw);
    expect(parsed !== null && serializeFrame(parsed)).toBe(raw);
  });

  it.each([
    { ...rootRow, threadId: 1 },
    { ...nestedRow, parentThreadId: false },
    { ...rootRow, rootThreadId: {} },
  ])("rejects a row whose pointers have the wrong type", (entry) => {
    expect(parseInboxFrame(JSON.stringify({ t: "entry", entry }))).toBeNull();
  });
});

describe("addressing a thread row upstream", () => {
  const upstream: Record<string, InboxClientFrame> = {
    "read:thread": { t: "read", channelId: "room-7", threadId: "m_root" },
    "mute:thread": { t: "mute", channelId: "room-7", muted: true, threadId: "m_reply" },
    "read:channel": { t: "read", channelId: "room-7" },
    "mute:channel": { t: "mute", channelId: "room-7", muted: false },
  };

  it.each(Object.entries(upstream))("%s round-trips", (_name, frame) => {
    const parsed = parseInboxClientFrame(serializeFrame(frame));
    expect(parsed).toStrictEqual(frame);
    expect(parsed !== null && isKnownInboxClientFrame(parsed)).toBe(true);
  });

  it("rejects a non-string threadId", () => {
    expect(parseInboxClientFrame('{"t":"read","channelId":"r","threadId":3}')).toBeNull();
    expect(
      parseInboxClientFrame('{"t":"mute","channelId":"r","muted":true,"threadId":null}'),
    ).toBeNull();
  });
});

describe("thread HTTP shapes", () => {
  it("types the registry response and the reply publish body", () => {
    const node = {
      id: "m_root",
      rootThreadId: "m_root",
      depth: 0,
      spawnSeq: 100,
      spawnedBy: { id: "u_1" },
      latestSeq: 102,
      threadSeq: 2,
      createdAt: 1751980000000,
    } satisfies ThreadNodeWire;
    const child = { ...node, id: "m_reply", parentThreadId: "m_root", depth: 1 } satisfies ThreadNodeWire;
    const page = { threads: [node, child], hasMore: false } satisfies ThreadsResponse;
    const pageWithMore = {
      threads: [node],
      hasMore: true,
      nextCursor: "c_1",
    } satisfies ThreadsResponse;
    const body = { content: { text: "hi" }, threadParentId: "m_root" } satisfies PublishBody;
    const rejected = {
      code: "validation_failed",
      reason: "thread_depth_exceeded",
    } satisfies PublishErrorBody;

    expect(page.threads.map((t) => t.depth)).toEqual([0, 1]);
    expect(pageWithMore.nextCursor).toBe("c_1");
    expect(body.threadParentId).toBe("m_root");
    expect(rejected.reason).toBe("thread_depth_exceeded");
  });
});
