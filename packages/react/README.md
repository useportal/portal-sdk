# @portalsdk/react

React bindings for the Portal client — a thin hook layer over
[`@portalsdk/core`](https://www.npmjs.com/package/@portalsdk/core). The hooks are selectors
over core's reactive stores (via `useSyncExternalStore`); they never own connections, so
mounting a component opens the socket and unmounting releases it.

Client-only: the hooks connect over WebSockets and read the DOM. They ship `"use client"`
and throw if run during server-side rendering or inside a React Server Component. There is no
SSR support in v1.

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

## `useChannel`

```ts
const result = useChannel<M>({ channelId, readOn, history, metadata, onMention, onError });
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

The result mirrors the channel: `messages`, `send`, `loadPrevious` / `hasPrevious` /
`isLoadingPrevious`, `channel` (info), `me`, `presence`, `activity` / `sendActivity` /
`typing` / `sendTyping`, `unread` / `markAsRead`, and `status`.

Content types are per call site: `useChannel<M>({ … })`.

## `useInbox`

```ts
const { channels, items, counter, unseen, markAllRead, status } = useInbox<D>(query);
```

- `channels` / `items` — the (optionally filtered) conversation rows and item feed.
- `counter` — the **global** badge (ignores this view's filter).
- `unseen` — unseen items **within this view's filter**.
- `markAllRead` — global, zero-arg.
- `query` — `{ channelId?, where? }` to scope the view.

Anonymous users get a permanently-empty ready inbox, so calling code needs no special case.

## License

MIT
