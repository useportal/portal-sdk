import {
  parseChannelClientFrame,
  serializeFrame,
  type ChannelReadyFrame,
  type ChannelServerFrame,
  type ParsedChannelClientFrame,
} from "@portalsdk/wire-protocol";

import type { Socket, SocketEvent, SocketFactory } from "../../src/transport/types.js";

/**
 * In-memory socket server for exercising the client's connection behavior. It speaks
 * exclusively through `@portalsdk/wire-protocol`: server→client frames are produced with
 * `serializeFrame`, and every client→server frame is read back through
 * `parseChannelClientFrame`. No real network, no `partysocket`.
 *
 * A {@link ConnectScript} runs once per connection attempt (a fresh connect, or a
 * reconnect the client triggered). The script decides what the server does — open and send
 * a `ready`, refuse the upgrade, or drop the socket — via the {@link ConnectContext}.
 */

/** What the server does for a single connection attempt. */
export type ConnectScript = (ctx: ConnectContext) => void;

export interface ConnectContext {
  /** The fully-resolved upgrade URL for this attempt (assert `token`/`key`/`last`/`leaf`). */
  readonly url: string;
  /** 1-based attempt number across the socket's life (increments on each reconnect). */
  readonly attempt: number;
  /** Emit `open` (upgrade succeeded, socket live). */
  open(): void;
  /** Serialize and deliver a server→client frame. */
  send(frame: ChannelServerFrame): void;
  /** Convenience: `open()` then a `ready` frame, with sensible defaults. */
  ready(overrides?: Partial<ChannelReadyFrame>): void;
  /** Refuse the upgrade with a refusal code (the socket never opens). */
  refuse(code: string, reason?: string): void;
  /** Drop the socket as a transient close (the client will report `reconnecting`). */
  drop(): void;
}

function channelIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/channels\/([^/]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : "channel";
}

function defaultReady(channelId: string): ChannelReadyFrame {
  return {
    t: "ready",
    channel: { id: channelId, mode: "standard" },
    me: { id: "u_test", anon: false, claims: {}, capabilities: { publish: true } },
    seq: 0,
    leaf: "leaf_0",
    presence: { mode: "detailed", participants: [], count: 0 },
    watermark: 0,
  };
}

/** One client socket, controllable by the test and inspectable after the fact. */
export class MockSocket implements Socket {
  /** Raw client→server frames, in send order. */
  readonly sent: string[] = [];
  closed = false;
  reconnectCount = 0;

  #onReconnect: (() => void) | undefined;

  constructor(private readonly onEvent: (event: SocketEvent) => void) {}

  send(data: string): void {
    this.sent.push(data);
  }

  reconnect(): void {
    this.reconnectCount++;
    this.#onReconnect?.();
  }

  close(): void {
    this.closed = true;
  }

  /** Parsed client→server frames the client sent. */
  get received(): (ParsedChannelClientFrame | null)[] {
    return this.sent.map(parseChannelClientFrame);
  }

  /** @internal — push a socket event to the connection, unless already closed. */
  emit(event: SocketEvent): void {
    if (!this.closed) this.onEvent(event);
  }

  /** @internal — wire the server's reconnect handler. */
  bindReconnect(fn: () => void): void {
    this.#onReconnect = fn;
  }
}

export class MockSocketServer {
  /** Sockets created — one per `factory` call (a reconnect reuses its socket). */
  readonly sockets: MockSocket[] = [];
  /** Resolved upgrade URLs — one per attempt, reconnects included. */
  readonly urls: string[] = [];

  #attempt = 0;

  constructor(private readonly script: ConnectScript) {}

  /** The current (most recently created) socket. */
  get socket(): MockSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }

  readonly factory: SocketFactory = (init): Socket => {
    const socket = new MockSocket(init.onEvent);
    this.sockets.push(socket);

    const runAttempt = async (): Promise<void> => {
      const url = await init.url();
      if (socket.closed) return;
      this.urls.push(url);
      this.#attempt++;
      this.script(this.#context(socket, url, this.#attempt));
    };

    socket.bindReconnect(() => {
      void runAttempt();
    });
    void runAttempt();
    return socket;
  };

  #context(socket: MockSocket, url: string, attempt: number): ConnectContext {
    const channelId = channelIdFromUrl(url);
    return {
      url,
      attempt,
      open: () => socket.emit({ type: "open" }),
      send: (frame) => socket.emit({ type: "message", data: serializeFrame(frame) }),
      ready: (overrides) => {
        socket.emit({ type: "open" });
        socket.emit({
          type: "message",
          data: serializeFrame({ ...defaultReady(channelId), ...overrides }),
        });
      },
      refuse: (code, reason) =>
        socket.emit(
          reason === undefined
            ? { type: "refused", code }
            : { type: "refused", code, reason },
        ),
      drop: () => socket.emit({ type: "closed" }),
    };
  }
}
