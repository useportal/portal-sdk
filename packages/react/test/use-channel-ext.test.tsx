import type { ReactNode } from "react";

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Portal } from "@portalsdk/core";

import { PortalProvider } from "../src/index.js";
import { useChannel } from "../src/use-channel.js";
import { installMocks, MockSocketServer, resetMocks } from "./harness.js";

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

describe("useChannel ext", () => {
  it("surfaces the ready frame's extension snapshots", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready({ ext: { counter: { total: 4 } } }));
    installMocks(server);
    const { result } = renderHook(() => useChannel({ channelId: "room" }), {
      wrapper: wrapperFor(makePortal()),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.ext).toEqual({ counter: { total: 4 } });
  });

  it("is undefined when ready carries no ext, and while inert", async () => {
    const server = new MockSocketServer((ctx) => ctx.ready());
    installMocks(server);
    // Inert: no channel selected.
    const { result } = renderHook(() => useChannel({ channelId: undefined }), {
      wrapper: wrapperFor(makePortal()),
    });
    expect(result.current.ext).toBeUndefined();

    const { result: connected } = renderHook(() => useChannel({ channelId: "room" }), {
      wrapper: wrapperFor(makePortal()),
    });
    await waitFor(() => expect(connected.current.status).toBe("ready"));
    expect(connected.current.ext).toBeUndefined();
  });

  it("re-renders with the replaced record when a new ready lands", async () => {
    let connects = 0;
    const server = new MockSocketServer((ctx) => {
      connects += 1;
      ctx.ready(
        connects === 1
          ? { seq: 5, ext: { counter: { total: 1 }, poll: { open: true } } }
          : { seq: 5, ext: { counter: { total: 2 } } },
      );
    });
    installMocks(server);

    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useChannel({ channelId: "room" });
      },
      { wrapper: wrapperFor(makePortal()) },
    );

    await waitFor(() =>
      expect(result.current.ext).toEqual({ counter: { total: 1 }, poll: { open: true } }),
    );
    const before = renders;

    server.socket?.reconnect();

    await waitFor(() => expect(result.current.ext).toEqual({ counter: { total: 2 } }));
    // The replacement drove an actual render, not just a store mutation.
    expect(renders).toBeGreaterThan(before);
    expect(result.current.ext).not.toHaveProperty("poll");
  });
});
