# Quickstart

Portal gives your app realtime channels and a per-user inbox over a single WebSocket,
with reactive bindings for React. This page gets a chat-shaped channel on screen with
zero backend, then shows what changes once you have real, identified users.

## Install

```bash
npm install @portalsdk/core @portalsdk/react
```

`@portalsdk/react` has a peer dependency on `react` (`>=18 <20`).

## Zero-backend: anonymous mode

You don't need a backend, a token endpoint, or even a signed-up user to try Portal.
Construct a client with just your publishable API key, and every user who loads the
page gets a stable anonymous identity for free:

```tsx
import { Portal } from "@portalsdk/core";
import { PortalProvider, useChannel } from "@portalsdk/react";

// Construct once, at module scope. Construction is synchronous and passive —
// nothing happens on the wire until a component actually mounts a channel.
const portal = new Portal({ apiKey: "pk_your_publishable_key" });

interface ChatMessage {
  text: string;
}

function ChatRoom() {
  const { messages, send } = useChannel<ChatMessage>({ channelId: "lobby" });

  return (
    <div>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.content.text}</li>
        ))}
      </ul>
      <button onClick={() => send({ content: { text: "hello" } })}>Send</button>
    </div>
  );
}

export function App() {
  return (
    <PortalProvider client={portal}>
      <ChatRoom />
    </PortalProvider>
  );
}
```

A few things worth noticing:

- `portal.channel(id)` (what `useChannel` calls under the hood) returns the same handle
  for the same id, so multiple components watching `"lobby"` share one socket.
- Anonymous users get a stable identity across page refreshes, an empty inbox, and are
  refused from any channel whose config sets `anonymous: false` (see
  [Tokens & auth](/core/tokens-and-auth)).
- `apiKey` is a publishable key — safe to ship in a browser bundle.

## Add real users

When you're ready to attach Portal to your own auth, pass a `token` — either directly
to the `Portal` constructor, or later via `PortalProvider`'s `token` prop (which forwards
to `client.setToken`). A `token` is a string or an async callback that resolves to one;
the callback form is recommended, since it's re-invoked on connect, reconnect, and
expiry.

The token itself is a signed JWT identifying the user, issued by your backend. Stand up
a small endpoint that authenticates the request however your app already does, then
returns that token:

```tsx
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

function ChatRoom() {
  const { messages, send } = useChannel<ChatMessage>({ channelId: "lobby" });
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
    <PortalProvider client={portal} token={fetchPortalToken}>
      <ChatRoom />
    </PortalProvider>
  );
}
```

On login, call `portal.setToken(fetchPortalToken)` directly (or update the `token` prop)
to move the client from anonymous to identified without remounting. On logout,
`portal.setToken(undefined)` returns the client to anonymous mode. Live channels and the
inbox re-authenticate in place — see [Tokens & auth](/core/tokens-and-auth) for the full
picture, and [Authoring portal.config.ts](/config-cli/portal-config) for verifying your
own JWTs.

> **Doc gap:** the exact contract for `/api/portal-token` above is intentionally left
> generic. The material available to write these docs covers *verifying your own JWTs*
> (`auth` in `portal.config.ts`) in detail, but doesn't document a public endpoint or
> process for the alternative path — tokens "minted by Portal" — that
> `@portalsdk/config` references as the default. If your project relies on
> Portal-minted tokens rather than your own JWTs, that flow isn't covered here yet.

## Next steps

- [Core SDK → Client setup](/core/client-setup) for the full client surface.
- [React → PortalProvider](/react/provider) and [useChannel](/react/use-channel) for the
  hook API.
- [Guides → Realtime chat](/guides/realtime-chat) for a complete, copy-pasteable room.
