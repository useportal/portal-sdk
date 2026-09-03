import type { ReactNode } from "react";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { serializeFrame, type WireMessage } from "@portalsdk/wire-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockedError, Portal } from "@portalsdk/core";

import { PortalProvider } from "../src/index.js";
import { useChannel } from "../src/use-channel.js";
import { useThread } from "../src/use-thread.js";
import { installMocks, MockHttpClient, MockSocketServer, resetMocks } from "./harness.js";

afterEach(() => {
  cleanup();
  resetMocks();
});

function makePortal(): Portal {
  return new Portal({
    apiKey: "pk",
    token: "jwt",
    apiUrl: "http://mock.test",
    realtimeUrl: "ws://mock.test",
  });
}

function wrapperFor(portal: Portal) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <PortalProvider client={portal}>{children}</PortalProvider>;
  };
}

function reply(seq: number, parent: string, threadSeq: number): WireMessage {
  return {
    id: `m_${seq}`,
    seq,
    type: "message",
    kind: "text",
    content: { text: `reply ${seq}` },
    sender: { id: "u_other", anon: false },
    timestamp: 1_000 + seq,
    retracted: false,
    ephemeral: false,
    threadParentId: parent,
    threadSeq,
  };
}

const deliver = (server: MockSocketServer, ...msgs: WireMessage[]): void =>
  server.socket?.emit({ type: "message", data: serializeFrame({ t: "batch", msgs }) });

describe("useThread over the mock server", () => {
  it("opens the channel on its own, loads the thread lazily, and narrows to it", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 5 }));
    const http = installMocks(
      server,
      new MockHttpClient({
        onHistory: (_c, q) =>
          q.threadParentId === "m_1"
            ? { msgs: [reply(2, "m_1", 1), reply(3, "m_1", 2)], hasMore: false }
            : { msgs: [reply(4, "m_9", 1)], hasMore: false },
      }),
    );
    const { result } = renderHook(
      () => useThread({ channelId: "room", threadId: "m_1", history: "none" }),
      { wrapper: wrapperFor(makePortal()) },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(server.sockets).toHaveLength(1);
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m_2", "m_3"]);
    expect(result.current.hasPrevious).toBe(false);
    expect(http.historyCalls.map((c) => c.query.threadParentId)).toEqual(["m_1"]);
  });

  it("re-renders on its own replies only", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 1 }));
    installMocks(server);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useThread({ channelId: "room", threadId: "m_1", history: "none" });
      },
      { wrapper: wrapperFor(makePortal()) },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // Let the lazy initial page settle so the count below is not disturbed by it.
    await act(async () => {});
    const settled = renders;

    act(() => deliver(server, reply(2, "m_other", 1)));
    expect(result.current.messages).toHaveLength(0);
    expect(renders).toBe(settled);

    act(() => deliver(server, reply(3, "m_1", 1)));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m_3"]);
    expect(renders).toBe(settled + 1);
  });

  it("releases the lens on unmount, not the connection", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 1 }));
    installMocks(server);
    const portal = makePortal();
    const wrapper = wrapperFor(portal);
    const onMessage = vi.fn();

    const channel = renderHook(() => useChannel({ channelId: "room" }), { wrapper });
    const thread = renderHook(
      () => useThread({ channelId: "room", threadId: "m_1", onMessage }),
      { wrapper },
    );
    await waitFor(() => {
      expect(channel.result.current.status).toBe("ready");
      expect(thread.result.current.status).toBe("ready");
    });
    expect(server.sockets).toHaveLength(1);

    thread.unmount();

    // The channel hook still holds the connection: same socket, open, never reconnected.
    expect(server.sockets).toHaveLength(1);
    expect(server.socket?.closed).toBe(false);
    expect(server.socket?.reconnectCount).toBe(0);
    expect(channel.result.current.status).toBe("ready");

    // The lens is released: its callbacks are gone, while the channel keeps receiving.
    act(() => deliver(server, reply(2, "m_1", 1)));
    expect(onMessage).not.toHaveBeenCalled();
    expect(channel.result.current.messages.map((m) => m.id)).toEqual(["m_2"]);
  });

  it("sends into the thread and surfaces a depth refusal as BlockedError", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 1 }));
    const http = installMocks(
      server,
      new MockHttpClient({
        onPublish: (_c, body) =>
          body.threadParentId === "m_deep"
            ? { ok: false, code: "validation_failed", reason: "thread_depth_exceeded" }
            : { ok: true, ack: { id: "m_srv", seq: 2, timestamp: 0 } },
      }),
    );
    const portal = makePortal();
    const ok = renderHook(() => useThread<string>({ channelId: "room", threadId: "m_1" }), {
      wrapper: wrapperFor(portal),
    });
    const deep = renderHook(() => useThread<string>({ channelId: "room", threadId: "m_deep" }), {
      wrapper: wrapperFor(portal),
    });
    await waitFor(() => expect(ok.result.current.status).toBe("ready"));

    await act(async () => {
      await ok.result.current.send({ content: "in thread" });
    });
    expect(http.publishCalls[0]?.body).toMatchObject({ content: "in thread", threadParentId: "m_1" });
    expect(ok.result.current.messages.map((m) => m.id)).toEqual(["m_srv"]);
    expect(deep.result.current.messages).toHaveLength(0);

    let error: unknown;
    await act(async () => {
      error = await deep.result.current.send({ content: "too deep" }).catch((e: unknown) => e);
    });
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as BlockedError).reason).toBe("thread_depth_exceeded");
    expect(deep.result.current.messages).toHaveLength(0);
  });

  it("pages older replies of this thread through loadPrevious", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 9 }));
    installMocks(
      server,
      new MockHttpClient({
        onHistory: (_c, q) => {
          if (q.threadParentId !== "m_1") return { msgs: [], hasMore: false };
          if (q.before === undefined) return { msgs: [reply(8, "m_1", 2)], hasMore: true };
          return { msgs: [reply(7, "m_1", 1)], hasMore: false };
        },
      }),
    );
    const { result } = renderHook(
      () => useThread({ channelId: "room", threadId: "m_1", history: "none" }),
      { wrapper: wrapperFor(makePortal()) },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.hasPrevious).toBe(true);

    let more: boolean | undefined;
    await act(async () => {
      more = await result.current.loadPrevious();
    });
    expect(more).toBe(false);
    expect(result.current.messages.map((m) => m.id)).toEqual(["m_7", "m_8"]);
    expect(result.current.hasPrevious).toBe(false);
    expect(result.current.isLoadingPrevious).toBe(false);
  });

  it("is inert with no channel selected", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready());
    installMocks(server);
    const { result } = renderHook(() => useThread({ channelId: undefined, threadId: "m_1" }), {
      wrapper: wrapperFor(makePortal()),
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.messages).toEqual([]);
    expect(server.sockets).toHaveLength(0);
    await expect(result.current.send({ content: "x" })).rejects.toThrow();
    await expect(result.current.loadPrevious()).resolves.toBe(false);
  });
});

describe("useThread: prop changes and error mapping", () => {
  it("switching threadId moves to the other lens and releases the old one's callbacks", async () => {
    const server = new MockSocketServer((ctx) => {
      ctx.ready({ seq: 1 });
      ctx.send({ t: "batch", msgs: [reply(2, "m_1", 1), reply(3, "m_2", 1)] });
    });
    installMocks(server);
    const onMessage = vi.fn();
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useThread({ channelId: "room", threadId, history: "none", onMessage }),
      { wrapper: wrapperFor(makePortal()), initialProps: { threadId: "m_1" } },
    );
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["m_2"]));
    expect(onMessage.mock.calls.map((c) => c[0]?.id)).toEqual(["m_2"]); // the mount delivery
    onMessage.mockClear();

    rerender({ threadId: "m_2" });
    expect(result.current.messages.map((m) => m.id)).toEqual(["m_3"]);
    // Still one socket: a thread switch is a lens switch, not a reconnect.
    expect(server.sockets).toHaveLength(1);
    expect(server.socket?.reconnectCount).toBe(0);

    act(() => deliver(server, reply(4, "m_1", 2), reply(5, "m_2", 2)));
    expect(onMessage.mock.calls.map((c) => c[0]?.id)).toEqual(["m_5"]);
    expect(result.current.messages.map((m) => m.id)).toEqual(["m_3", "m_5"]);
  });

  it("switching channelId releases the old channel and acquires the new one", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ seq: 1 }));
    installMocks(server);
    const { result, rerender } = renderHook(
      ({ channelId }: { channelId: string }) => useThread({ channelId, threadId: "m_1" }),
      { wrapper: wrapperFor(makePortal()), initialProps: { channelId: "room-a" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(server.urls[0]).toContain("room-a");

    rerender({ channelId: "room-b" });
    await waitFor(() => expect(server.sockets).toHaveLength(2));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(server.urls[1]).toContain("room-b");
    // The old channel's release is deferred by core's grace period; it is not torn down yet
    // (a fast switch back would reuse it), and the new one is live.
    expect(server.sockets[1]?.closed).toBe(false);
  });

  it("maps in-session errors and terminal refusals to onError", async () => {
    const server = new MockSocketServer((ctx) => ctx.refuse("invalid_api_key"));
    installMocks(server);
    const onError = vi.fn();
    const { result } = renderHook(
      () => useThread({ channelId: "room", threadId: "m_1", onError }),
      { wrapper: wrapperFor(makePortal()) },
    );
    await waitFor(() => expect(result.current.status).toBe("blocked"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.code).toBe("invalid_api_key");
  });

  it("rejects a where filter loudly, like useChannel", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready());
    installMocks(server);
    expect(() =>
      renderHook(
        () => useThread({ channelId: "room", threadId: "m_1", where: { retracted: { eq: false } } }),
        { wrapper: wrapperFor(makePortal()) },
      ),
    ).toThrow(/reserved/);
  });

  it("fires onMention for this thread's mentions only", async () => {
    const server = new MockSocketServer((ctx) =>
      ctx.ready({ seq: 1, me: { id: "u_me", anon: false, claims: {}, capabilities: {} } }),
    );
    installMocks(server);
    const onMention = vi.fn();
    const { result } = renderHook(
      () => useThread({ channelId: "room", threadId: "m_1", history: "none", onMention }),
      { wrapper: wrapperFor(makePortal()) },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() =>
      deliver(
        server,
        { ...reply(2, "m_1", 1), mentions: [{ userId: "u_me" }] },
        { ...reply(3, "m_9", 1), mentions: [{ userId: "u_me" }] },
      ),
    );
    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention.mock.calls[0]?.[0]?.id).toBe("m_2");
  });
});
