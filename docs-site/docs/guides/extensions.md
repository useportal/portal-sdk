# Guide: Channel extensions

An extension is your own code running alongside a channel. It owns a slice of the
channel's message types — a namespace like `counter.` — and Portal runs one durable
instance of it per channel. Clients publish into the namespace, Portal hands your code
the messages a batch at a time, and whatever you return is broadcast to everyone in the
channel.

This guide builds one end to end: a counter that everybody in a room can increment, with
a running total that stays correct for someone who joins an hour late.

Three pieces, in order:

1. **Author** the extension — a class plus a static manifest.
2. **Attach** it to a channel in `portal.config.ts` and `portal deploy`.
3. **Consume** it from the client — send into the namespace, render live broadcasts, and
   read the snapshot on join.

## Why a snapshot exists

The thing that makes an extension more than a message filter is the split between *live*
and *joined-late*.

- A client that is already connected sees each broadcast as it happens, through
  `onMessage`.
- A client that connects afterwards missed all of them. It needs the current state, not
  the history of how the state got there.

Your extension answers the second case with `onSnapshot`, and Portal caches that answer
and hands it to every joining client in the connect frame. On the client it arrives as
`channel.ext.<handle>` — populated before your UI's first render, without a round trip
and without waiting for the next broadcast.

## 1. Author the extension

```sh
npm install @portalsdk/extension-protocol
```

The package is **types only** — nothing in it runs. Portal generates the plumbing that
connects your class to the platform when you deploy.

```ts
// file: extensions/counter.ts
import {
  defineExtension,
  type BatchRequest,
  type ExtensionContext,
  type ExtensionManifest,
} from "@portalsdk/extension-protocol";

class Counter {
  static manifest: ExtensionManifest = {
    namespace: "counter.",
    transport: "ws",
  };

  #total = 0;

  constructor(private ctx: ExtensionContext) {}

  // Instances are recycled when a channel goes idle — reload from storage, don't assume zero.
  async onInit() {
    this.#total = (await this.ctx.storage.get<number>("total")) ?? 0;
  }

  async onBatch({ messages }: BatchRequest) {
    const bumps = messages.filter((m) => m.type === "counter.increment").length;
    if (bumps === 0) return;

    this.#total += bumps;
    await this.ctx.storage.put("total", this.#total);

    return {
      broadcasts: [{ type: "counter.state", content: { total: this.#total } }],
      snapshotDirty: true,
    };
  }

  async onSnapshot() {
    return { snapshot: { total: this.#total } };
  }
}

export default defineExtension(Counter);
```

### The manifest

Every extension declares its own facts as a static `manifest`:

| Field | Meaning |
|---|---|
| `namespace` | The message-type prefix you own, **ending in a dot** (`"counter."`). Every type you send and receive lives under it. |
| `transport` | `"ws"` if clients publish over the channel's WebSocket, `"http"` for HTTP requests. Clients never choose this — Portal routes their `send()` by the manifest. |

Two extensions on the same channel may not claim the same namespace, and a channel
carries at most **5**. `portal deploy` rejects violations before anything ships.

### The handlers

| Handler | When | Required |
|---|---|---|
| `onInit` | Once, before the first batch, when your extension first sees activity on a channel. | no |
| `onBatch` | With each batch of messages published to your namespace. | **yes** |
| `onSnapshot` | To build the state a joining client needs to render. Portal may call it at any time, including while batches are in flight. | no |
| `onShutdown` | Best effort, when the channel goes quiet. | no |

Returning nothing from `onBatch` means "no output" — that's the `bumps === 0` branch
above. Each broadcast `type` must start with your namespace or it is dropped.

Set `snapshotDirty: true` on a batch that changed what a joining client should see, so
Portal refreshes the cached snapshot. Skip it and late joiners keep getting a stale total
until the next dirty batch.

### State, and what survives what

Your extension is a **durable, per-channel instance** — one lives for each channel it is
attached to, and it is yours alone.

- **Instance fields persist across invocations.** `#total` is still there on the next
  batch; you do not rebuild it every time.
- **`ctx.storage` is for surviving a restart.** Instances are recycled once a channel is
  idle long enough, and anything held only in memory goes with them. That is why `onInit`
  reads `total` back.
- **`onSnapshot` is not your recovery mechanism.** It answers "what should someone who
  just arrived see?", never "what did I lose?". Recovery is `ctx.storage` plus `onInit`.
- **`onShutdown` may never fire.** It is best effort and Portal does not wait for your
  reply, so never leave work that matters until it arrives. Persist as you go, like the
  `storage.put` in `onBatch`.

**Batches arrive at least once.** After a network failure Portal may redeliver a batch you
already handled. Each carries a `batchSeq` that counts up by one — if reprocessing would
double-count, ignore any number you have already seen:

```ts
// file: extensions/idempotent.ts
import type { BatchRequest, ExtensionContext } from "@portalsdk/extension-protocol";

class Guarded {
  #lastSeq = -1;

  constructor(private ctx: ExtensionContext) {}

  async onBatch({ batchSeq, messages }: BatchRequest) {
    if (batchSeq <= this.#lastSeq) return; // already applied
    this.#lastSeq = batchSeq;
    await this.ctx.storage.put("lastSeq", batchSeq);
    // ...apply `messages`
  }
}
```

## 2. Attach it and deploy

The config points at the file; the namespace and transport come from the extension's own
manifest. The **handle** you choose on the left is how the attachment is identified — and
it is the key clients read the snapshot under, so pick it deliberately.

```ts
// file: portal.config.ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  channels: {
    "room-*": {
      extensions: {
        counter: "./extensions/counter.ts",
      },
    },
  },
});
```

```sh
portal deploy
```

The CLI reads each attached extension's manifest, validates namespaces, bundles each
extension separately, and uploads it.

## 3. Consume it from the client

There is **no extension client API** — no `useExtension`, nothing to import. An extension
shows up through three surfaces you already have.

### Sending: namespaced types

`send()` is the entry point. A `type` carrying a namespace prefix is routed by that prefix
against the transport map the connect frame provides, so a `ws` extension travels as an
ephemeral frame and an `http` one as a publish — the call site looks identical either way:

```ts
// file: send.ts
import { Portal } from "@portalsdk/core";

declare const portal: Portal;
const channel = portal.channel("room-42");

await channel.send({ ephemeral: true, type: "counter.increment", content: {} });
```

Sending into a namespace whose extension is currently degraded rejects with
`DegradedError`. The channel itself keeps working — a broken extension never takes the
room down with it.

### Live updates: `onMessage`

Broadcasts arrive as ordinary channel messages. Filter by the namespace:

```ts
// file: live.ts
import { Portal } from "@portalsdk/core";

declare const portal: Portal;
const channel = portal.channel("room-42");

channel.on("message", (msg) => {
  if (msg.type !== "counter.state") return;
  const { total } = msg.content as { total: number };
  console.log("total is now", total);
});
```

### Joining late: `channel.ext`

`channel.ext` is the record of extension snapshots from the connect frame, keyed by the
handle you chose in `portal.config.ts`. It is the late joiner's whole story: present at
`ready`, before any broadcast arrives.

Blobs belong to the extension that produced them, so they are typed `unknown` — cast at
the read site:

```ts
// file: late-join.ts
import { Portal } from "@portalsdk/core";

interface CounterState {
  total: number;
}

declare const portal: Portal;
const channel = portal.channel("room-42");

const state = channel.ext?.["counter"] as CounterState | undefined;
console.log("starting total", state?.total ?? 0);
```

Three rules worth internalizing:

- **`undefined` before `ready`.** There is no snapshot until the connect frame lands.
- **A degraded extension is key-absent, never null.** `ext.counter === undefined` means
  "no snapshot available" — either the handle isn't attached, or its extension is
  currently degraded. You never have to distinguish `null` from missing.
- **The record is replaced wholesale on every `ready`, including reconnects.** A handle
  that disappears between sessions disappears from `ext` too, so a stale blob can never
  masquerade as live state.

## The complete pair

The extension above, and the React component that consumes it. Snapshot for the initial
value, broadcasts for everything after — the same two sources, joined in one `useState`:

```tsx
// file: Counter.tsx
"use client";

import { useEffect, useState } from "react";
import { useChannel } from "@portalsdk/react";

interface CounterState {
  total: number;
}

export function Counter({ roomId }: { roomId: string }) {
  const [total, setTotal] = useState<number | undefined>(undefined);

  const { send, ext, status } = useChannel({
    channelId: roomId,
    onMessage: (msg) => {
      // Live: every broadcast after we connected.
      if (msg.type !== "counter.state") return;
      setTotal((msg.content as CounterState).total);
    },
  });

  // Late join: the snapshot is already here at ready, before any broadcast.
  // Re-runs when a reconnect replaces the record, and never clobbers a newer live value.
  useEffect(() => {
    const snapshot = ext?.["counter"] as CounterState | undefined;
    if (snapshot !== undefined) setTotal((current) => current ?? snapshot.total);
  }, [ext]);

  if (status !== "ready") return <p>Connecting…</p>;

  return (
    <div>
      <p>Total: {total ?? 0}</p>
      <button
        onClick={() => {
          void send({ ephemeral: true, type: "counter.increment", content: {} });
        }}
      >
        Increment
      </button>
    </div>
  );
}
```

Open it in two tabs. The first increments and both stay in step through `counter.state`.
Close the second, increment a few more times, then reopen it: it renders the correct
total immediately — from `ext.counter`, with no replay and no round trip.

## Limits and gotchas

- **At most 5 extensions per channel**, each owning a distinct namespace.
- **Validate `content` yourself.** Portal does not inspect what clients publish into your
  namespace — `ExtensionMessage.content` is `unknown` on purpose.
- **`epoch` increments when a channel restarts.** If you cache anything keyed to channel
  lifetime, reset it when the epoch changes.
- **Snapshots should stay small.** Every joining client receives the blob inline in the
  connect frame; it is current state for rendering, not an archive.
- **A degraded extension degrades alone.** Sends into its namespace reject with
  `DegradedError` and its `ext` key vanishes, while the channel keeps delivering ordinary
  messages.
