# SSR & Next.js

Both `@portalsdk/core` and `@portalsdk/react` are client-only — meant to run in a browser,
not inside server code. Only `@portalsdk/react`'s dist ships a `"use client"` directive
(`@portalsdk/core` has no React dependency and doesn't need one; its hooks are the actual
Client Component boundary).

**`@portalsdk/react`'s hooks are SSR-inert, not throwing.** During server rendering
(`typeof window === "undefined"` — which includes a Next.js Client Component's server
prerender pass, which runs despite `"use client"`), `useChannel`/`useInbox` render a stable
idle snapshot instead of connecting: no `acquire()`, no network, nothing thrown. On an actual
client this never engages — behavior there is unchanged.

## App Router

Render anything that touches `useChannel` or `useInbox` from a Client Component, same as any
other stateful hook — no special wrapper is required:

```tsx
// file: chat-room.tsx
// app/chat/chat-room.tsx
"use client";

import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

export function ChatRoom() {
  const { messages, send } = useChannel<ChatMessage>({ channelId: "lobby" });

  return (
    <div>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.content.text}</li>
        ))}
      </ul>
      <button onClick={() => send({ content: { text: "hi" } })}>Send</button>
    </div>
  );
}
```

A Server Component page can render that Client Component normally — Portal only needs
to own the leaf that actually calls the hooks; everything above it in the tree can stay
a Server Component:

```tsx
// file: page.tsx
// app/chat/page.tsx
import { ChatRoom } from "./chat-room";

export default function ChatPage() {
  return <ChatRoom />;
}
```

The same applies to `PortalProvider` — see [PortalProvider](/react/provider) for where
to put the client instance and provider in an App Router tree.

## `dynamic(..., { ssr: false })` is not required

That workaround exists for hooks that genuinely can't tolerate running during server
rendering. Portal's hooks can: during the server's prerender pass, `ChatRoom` above renders
its inert idle state (`status: "idle"`, empty `messages`) rather than throwing or connecting;
once the same component re-renders in the browser, it connects normally. You only need
`ssr: false` here for reasons unrelated to Portal — e.g. another dependency in the same
component that itself doesn't tolerate server rendering.

## Hydration

`useSyncExternalStore`'s `getServerSnapshot` argument is wired to the same idle snapshot the
hook renders during SSR. Since no handle is created server-side, the client's first
(pre-hydration-effects) render produces the identical inert shape too — so there's nothing
for React to warn about mismatching between server and client output.
