# SSR & Next.js

Both `@portalsdk/core` and `@portalsdk/react` are client-only. `@portalsdk/core` isn't
meant for server components; `@portalsdk/react`'s hooks connect over WebSockets and read
the DOM, so they ship a `"use client"` directive and throw if they run during
server-side rendering or inside a React Server Component. **There is no SSR support in
v1.**

## App Router

In the Next.js App Router, that means: render anything that touches `useChannel` or
`useInbox` from a Client Component.

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

Beyond "these are Client Components, and there's no SSR/RSC support," the published
packages don't document any App Router–specific integration (there's no framework
adapter, no `next/dynamic`/`ssr: false` guidance, and no hydration workaround shipped or
recommended) — treat the snippet above as the whole story for v1.
