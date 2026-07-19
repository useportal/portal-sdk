# PortalProvider

`@portalsdk/react` is a thin hook layer over `@portalsdk/core` — the hooks are selectors
over core's reactive stores (via `useSyncExternalStore`), and they never own
connections: mounting a component that calls `useChannel` opens the socket, and
unmounting releases it.

```bash
npm install @portalsdk/react @portalsdk/core
```

`react` (`>=18 <20`) is a peer dependency.

`PortalProvider` supplies a `Portal` client to every hook beneath it in the tree:

```tsx
import { Portal } from "@portalsdk/core";
import { PortalProvider, useChannel } from "@portalsdk/react";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

interface ChatMessage {
  text: string;
}

function Lobby() {
  const { messages } = useChannel<ChatMessage>({ channelId: "lobby" });
  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.content.text}</li>
      ))}
    </ul>
  );
}

export function App() {
  return (
    <PortalProvider client={portal}>
      <Lobby />
    </PortalProvider>
  );
}
```

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `client` | `Portal` | Required. The provider is otherwise passive — it just publishes `client` on context. Its lifecycle stays owned by whoever constructed it. |
| `token` | `string \| (() => string \| Promise<string>) \| undefined` | Optional. Forwarded to `client.setToken`. |
| `children` | `ReactNode` | |

Connections are opened and closed by the hooks (via the handle refcount), not by the
provider itself — the provider never touches the network on its own.

## Driving login/logout through `token`

```tsx
import { useState } from "react";
import { Portal } from "@portalsdk/core";
import { PortalProvider, useChannel } from "@portalsdk/react";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

async function fetchPortalToken(): Promise<string> {
  const res = await fetch("/api/portal-token", { credentials: "include" });
  const { token } = (await res.json()) as { token: string };
  return token;
}

interface ChatMessage {
  text: string;
}

function Lobby() {
  const { messages } = useChannel<ChatMessage>({ channelId: "lobby" });
  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.content.text}</li>
      ))}
    </ul>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState(false);

  return (
    <PortalProvider client={portal} token={signedIn ? fetchPortalToken : undefined}>
      <Lobby />
      <button onClick={() => setSignedIn(true)}>Sign in</button>
      <button onClick={() => setSignedIn(false)}>Sign out</button>
    </PortalProvider>
  );
}
```

A fresh inline callback on every render does **not** reconnect — only an actual change
of value or kind (string ↔ callback ↔ `undefined`) does, so `token={fetchPortalToken}`
above is safe to pass as a new closure each render. Omitting `token` entirely (as
opposed to passing `undefined`) leaves the client's own credential untouched — useful
when something other than this provider owns login state.

See [Tokens & auth](/core/tokens-and-auth) for what changing the token does to
already-mounted channels and the inbox.
