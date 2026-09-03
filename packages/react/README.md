# @portalsdk/react

React bindings for the Portal client — a thin hook layer over
[`@portalsdk/core`](https://www.npmjs.com/package/@portalsdk/core). The hooks are selectors
over core's reactive stores (via `useSyncExternalStore`); they never own connections, so
mounting a component opens the socket and unmounting releases it.

Client-only: the hooks connect over WebSockets and read the DOM. They ship `"use client"`.
During server rendering — including a Next.js Client Component's server prerender pass,
which runs despite `"use client"` — they render an inert idle snapshot instead of connecting:
no acquire, no network, nothing thrown. See
[Using with Next.js App Router](#using-with-nextjs-app-router).

## Install

```sh
npm install @portalsdk/react @portalsdk/core
```

`react` (>=18 <20) is a peer dependency.

## Quickstart

```tsx
"use client";
import { Portal } from "@portalsdk/core";
import { PortalProvider, useChannel, useInbox } from "@portalsdk/react";

// Construct once — synchronous and passive, no network until a hook mounts.
const portal = new Portal({
  apiKey: "pk_live_…",             // publishable; safe in the bundle
  token: async () => fetchJwt(),   // your signed user token (or a static string)
});

function App() {
  return (
    <PortalProvider client={portal}>
      <Badge />
      <Room channelId="room-7" />
    </PortalProvider>
  );
}

function Room({ channelId }: { channelId: string }) {
  const { messages, send, status, unread } = useChannel<{ text: string }>({ channelId });

  return (
    <div>
      <header>{status} · {unread} unread</header>
      {messages.map((m) => (
        <p key={m.id}>{m.content.text}</p>
      ))}
      <button onClick={() => send({ content: { text: "hello" } })}>Send</button>
    </div>
  );
}

function Badge() {
  const { counter } = useInbox();
  return <span>{counter}</span>;
}
```

## `PortalProvider`

Supplies the client to the hooks. It also accepts an optional `token` prop, forwarded to
`client.setToken` — pass a string or callback to log a user in, `undefined` to return to
anonymous mode. A fresh inline callback on every render does not reconnect; only a real
change of value or kind does.

```tsx
// Anonymous until a token arrives; swapping it in/out logs the user in and out.
<PortalProvider client={portal} token={session?.jwt}>
  {children}
</PortalProvider>
```

Omit the `token` prop entirely to leave the client's own credential (from `new Portal({ token })`
or anonymous mode) untouched.

## `useChannel`

```ts
const result = useChannel<M>({
  channelId, readOn, history, metadata, onMention, onMessage, onError,
});
```

- `channelId` — the room to subscribe to. `undefined` renders inert (no connection) — the
  two-pane "nothing selected" pattern. Changing the id releases the old room and acquires the
  new one.
- `readOn` — when the channel read position auto-advances: `"mount"` (default), `"visible"`
  (on a visible mount, then on each return to visibility), or `"manual"` (call `markAsRead`
  yourself).
- `history` — initial backfill on connect (`number`, default 50, or `"none"`).
- `metadata` — initial presence metadata for this session.
- `onMention` / `onError` — fire on a mention addressed to you and on a delivered error.
- `onMessage` — fires on every message delivered to this channel, persistent or ephemeral.
  Useful for high-frequency ephemeral traffic (live cursors, presence-adjacent signals) that
  you want to react to as discrete events rather than read off the accumulated `messages`.

The result mirrors the channel: `messages`, `send`, `loadPrevious` / `hasPrevious` /
`isLoadingPrevious`, `channel` (info), `me`, `presence`, `activity` / `sendActivity` /
`typing` / `sendTyping`, `unread` / `markAsRead`, `setMetadata`, and `status`.

`setMetadata(metadata)` replaces your own presence metadata mid-session — a direct
pass-through to the channel handle's `setMetadata`. Previously the only way to reach it was
holding the core `ChannelHandle` yourself (`portal.channel(id)`) alongside the hook; that
workaround still works (the handle is unchanged), but isn't necessary anymore.

Content types are per call site: `useChannel<M>({ … })`.

`messages` includes replies — messages carrying `threadParentId`, the id of the message they
answer. Filter them out to render a flat timeline, or use `useThread` to render one thread.

## `useThread`

```ts
const { messages, send, loadPrevious, hasPrevious, isLoadingPrevious, status } =
  useThread<M>({ channelId, threadId, history, onMessage, onMention, onError });
```

One thread of a channel: the same params as `useChannel` plus `threadId` — the id of the
message the thread hangs off (the first reply creates it). The hook shares the channel's
connection with every other hook on that channel, opening it if nothing else has, and holds
it only while mounted. The first mount loads the thread's latest replies; `loadPrevious`
pages that thread alone.

- `messages` — this thread's replies only, oldest first. It re-renders for this thread's
  changes, not for the rest of the channel.
- `send` — replies into this thread. Nesting deeper than the platform allows rejects with a
  `BlockedError` whose `reason` is `"thread_depth_exceeded"`.
- `onMessage` / `onMention` — fire for this thread's replies only. `readOn` has no effect: a
  thread has no read position of its own.

## `useInbox`


```ts
const { channels, items, counter, unseen, markAllRead, status } = useInbox<D>({
  channelId, where, onItem,
});
```

- `channels` / `items` — the (optionally filtered) conversation rows and item feed.
- `counter` — the **global** badge (ignores this view's filter).
- `unseen` — unseen items **within this view's filter**.
- `markAllRead` — global, zero-arg.
- `channelId` / `where` — scope the view.
- Thread entries sit beside their channel's entry with their own `unread`, `latest` and
  `muted`, carrying `threadId` / `parentThreadId` / `rootThreadId` for rendering;
  `channels.get(channelId, threadId)` addresses one. Which sub-thread to show, and any
  roll-up across a tree, is the app's call.

- `onItem` — fires once per item arriving after mount. Never fires for the items already
  present when the inbox becomes ready (that's what `items` is for), and never fires twice for
  the same item — a redelivered item updates its data in `items` but doesn't re-announce
  itself. A fresh inline callback on every render doesn't drop or duplicate events.

Anonymous users get a permanently-empty ready inbox, so calling code needs no special case.

Each item's `id` **is** the notification's idempotency key (see the sender's own docs), so
it's the right thing to key a toast list on:

```tsx
import { useState } from "react";
import { useInbox } from "@portalsdk/react";

function useAssignmentToasts() {
  const [toasts, setToasts] = useState<{ id: string; message: string }[]>([]);

  useInbox({
    onItem: (item) => {
      if (item.type !== "ticket.assigned") return;
      setToasts((current) => [...current, { id: item.id, message: item.title ?? "" }]);
    },
  });

  return toasts;
}
```

## Using with Next.js App Router

`useChannel`/`useInbox` are Client Component hooks (they ship `"use client"`), same as any
other stateful hook — no special wrapper is required. Put `PortalProvider` in a Client
Component near the root of the subtree that needs it, and call the hooks from Client
Components beneath it; everything above can stay a Server Component:

```tsx
// app/providers.tsx
"use client";
import { Portal } from "@portalsdk/core";
import { PortalProvider } from "@portalsdk/react";

const portal = new Portal({ apiKey: "pk_live_…" });

export function Providers({ children }: { children: React.ReactNode }) {
  return <PortalProvider client={portal}>{children}</PortalProvider>;
}
```

```tsx
// app/layout.tsx (Server Component)
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

`dynamic(() => import("./room"), { ssr: false })` is **not required** to use these hooks —
that workaround was for the pre-0.1.2 throwing behavior. During the server's prerender pass a
component calling `useChannel`/`useInbox` renders its inert idle state (no connection is
opened there); once the same component re-renders in the browser, it connects normally. You
only need `ssr: false` for reasons unrelated to Portal (e.g. another dependency that itself
doesn't tolerate server rendering).

## License

MIT
