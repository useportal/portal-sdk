import { afterEach, describe, expect, it, vi } from "vitest";

import { Portal, type ChannelHandle } from "../src/index.js";
import { resetHttpClientFactory, setHttpClientFactory } from "../src/http/factory.js";
import { resetSocketFactory, setSocketFactory } from "../src/transport/factory.js";
import { MockHttpClient } from "./mock-server/http.js";
import { MockSocketServer, type ConnectScript } from "./mock-server/index.js";

afterEach(() => {
  resetSocketFactory();
  resetHttpClientFactory();
  vi.useRealTimers();
});

function setup(script: ConnectScript): { channel: ChannelHandle; server: MockSocketServer } {
  const server = new MockSocketServer(script);
  setSocketFactory(server.factory);
  setHttpClientFactory(new MockHttpClient().factory);
  const channel = new Portal({ apiKey: "pk", token: "jwt" }).channel("room");
  channel.acquire();
  return { channel, server };
}

describe("channel.ext", () => {
  it("is undefined before ready", () => {
    const { channel } = setup(() => {
      /* never readies */
    });
    expect(channel.status).not.toBe("ready");
    expect(channel.ext).toBeUndefined();
  });

  it("exposes the per-handle snapshots carried on ready", async () => {
    const { channel } = setup((ctx) =>
      ctx.ready({ ext: { counter: { total: 7 }, poll: { votes: { a: 2 } } } }),
    );
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    expect(channel.ext).toEqual({ counter: { total: 7 }, poll: { votes: { a: 2 } } });
    // Blobs are extension-owned and typed `unknown` — this is the documented read pattern.
    expect((channel.ext?.["counter"] as { total: number }).total).toBe(7);
  });

  it("is undefined when ready carries no ext at all", async () => {
    const { channel } = setup((ctx) => ctx.ready({ seq: 0 }));
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    expect(channel.ext).toBeUndefined();
  });

  it("omits a degraded extension's handle rather than exposing null", async () => {
    // Wire contract: an unavailable extension is KEY-ABSENT, so a consumer's
    // `ext.counter === undefined` check is the degraded signal.
    const { channel } = setup((ctx) => ctx.ready({ ext: { poll: { votes: {} } } }));
    await vi.waitFor(() => expect(channel.status).toBe("ready"));

    expect(channel.ext).toEqual({ poll: { votes: {} } });
    expect(channel.ext).not.toHaveProperty("counter");
    expect(channel.ext?.["counter"]).toBeUndefined();
  });

  it("replaces the record wholesale on re-ready, dropping stale handles", async () => {
    let connects = 0;
    const { channel, server } = setup((ctx) => {
      connects += 1;
      ctx.ready(
        connects === 1
          ? { seq: 5, ext: { counter: { total: 1 }, poll: { votes: { a: 1 } } } }
          : { seq: 5, ext: { counter: { total: 9 } } },
      );
    });
    await vi.waitFor(() => expect(channel.ext).toEqual({
      counter: { total: 1 },
      poll: { votes: { a: 1 } },
    }));

    server.socket?.reconnect();
    await vi.waitFor(() => expect(channel.ext).toEqual({ counter: { total: 9 } }));

    // Merging would have kept `poll` alive after its extension detached.
    expect(channel.ext).not.toHaveProperty("poll");
  });

  it("clears a previously populated record when the new ready omits ext", async () => {
    let connects = 0;
    const { channel, server } = setup((ctx) => {
      connects += 1;
      ctx.ready(connects === 1 ? { seq: 5, ext: { counter: { total: 3 } } } : { seq: 5 });
    });
    await vi.waitFor(() => expect(channel.ext).toEqual({ counter: { total: 3 } }));

    server.socket?.reconnect();
    await vi.waitFor(() => expect(channel.ext).toBeUndefined());
  });
});
