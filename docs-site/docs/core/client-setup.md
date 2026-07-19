# Client setup

`@portalsdk/core` is the framework-agnostic Portal client: it manages realtime channels
and a per-user inbox over a WebSocket, and exposes reactive,
`useSyncExternalStore`-shaped stores you can bind to any UI. It's client-only — the
published package ships a `"use client"` directive and isn't meant for server
components (see [SSR & Next.js](/core/ssr-and-nextjs)).

```bash
npm install @portalsdk/core
```

## Construct a client

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({
  apiKey: "pk_your_publishable_key",
});
```

Construction is synchronous and passive: it stores your config and builds empty
registries, with no network call, no token fetch, and no validation. That makes it safe
to construct once at module scope, before any user exists — the first network activity
happens later, on the first channel `acquire()` or the first inbox subscription.

`PortalConfig` accepts:

| Field | Type | Notes |
| --- | --- | --- |
| `apiKey` | `string` | Publishable key identifying the app. Safe in the bundle. |
| `token` | `string \| (() => Promise<string>)` | Identifies the user. Optional — omit it for anonymous mode. A callback is re-invoked on connect, reconnect, and expiry (recommended); a plain string is used as-is. |
| `apiUrl` | `string` | Base URL override. Production hosts are baked in; primarily for development and testing. |
| `realtimeUrl` | `string` | Base URL override for the realtime socket. Same caveat as `apiUrl`. |

See [Tokens & auth](/core/tokens-and-auth) for everything `token` affects, including
anonymous mode and `setToken`.

## Get a channel handle

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

const room = portal.channel<ChatMessage>("room-1");
room.acquire();

room.subscribe(() => {
  console.log(room.getSnapshot().messages.length, "messages");
});

await room.send({ content: { text: "hello" } });

room.release();
```

`portal.channel(id, options?)` is a registry lookup-or-create: calling it again with the
same id returns the *same* handle, so many views of a room share one socket. Options
(`history`, `metadata`) apply only at first creation — a later call with different
options returns the existing handle and ignores them (a dev-mode warning fires; this is
silent in production).

A handle does nothing until `acquire()`-ed; call `release()` when you're done with it
(or use `using` for automatic cleanup, since `ChannelHandle` implements
`Symbol.dispose`):

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

function readLobbyOnce() {
  using room = portal.channel("lobby");
  room.acquire();
  return room.getSnapshot().messages.length;
}
```

If you're using React, [`useChannel`](/react/use-channel) manages `acquire()`/`release()`
for you via mount/unmount — most apps never call these directly.

## The inbox

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

const inbox = portal.inbox();
console.log(inbox.getSnapshot().counter);
```

`portal.inbox()` is a lazy singleton: it's created, and its connection opened, on first
call — never at construction. See [Inbox](/core/inbox) for the full surface.

## Switching identity

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

async function login(): Promise<string> {
  const res = await fetch("/api/portal-token", { credentials: "include" });
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function onSignIn() {
  portal.setToken(login);
}

function onSignOut() {
  portal.setToken(undefined);
}
```

`setToken` replaces the token source for every live channel and the inbox — see
[Tokens & auth](/core/tokens-and-auth).

## Package size

`@portalsdk/core` is ~14 kB min+gzip, with two runtime dependencies:
`@portalsdk/wire-protocol` (the wire-format types the client sends and parses) and
`partysocket`. You won't reach for either directly in normal use.
