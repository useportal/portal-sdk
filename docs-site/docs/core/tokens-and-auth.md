# Tokens & auth

## Anonymous mode

`token` on `PortalConfig` is optional. Omit it, and the client mints and manages its own
anonymous credential on first use, keeping one stable anonymous identity across page
refreshes:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" }); // no token → anonymous
```

Anonymous users:

- get `me.anon === true` on every channel they join;
- get a permanently-empty inbox (see [Inbox](/core/inbox));
- are refused, with `AnonymousNotAllowedError`, from any channel configured
  `anonymous: false` (see [Authoring portal.config.ts](/config-cli/portal-config)).

## Identified users

Pass `token` — a string, or (recommended) an async callback — either to the constructor
or later via `setToken`:

```ts
import { Portal } from "@portalsdk/core";

async function fetchPortalToken(): Promise<string> {
  const res = await fetch("/api/portal-token", { credentials: "include" });
  const { token } = (await res.json()) as { token: string };
  return token;
}

const portal = new Portal({
  apiKey: "pk_your_publishable_key",
  token: fetchPortalToken,
});
```

A callback is re-invoked on connect, reconnect, and token expiry, which is why it's the
recommended shape over a plain string — a static string can't be refreshed, so a
still-failing retry after expiry surfaces `TokenExpiredError` and moves the channel's
`status` to `"blocked"`.

The token itself is a signed JWT identifying the user. If you're verifying your own
JWTs (rather than relying on Portal-minted tokens), map your token's claims onto Portal
identity fields with the `auth` block in `portal.config.ts` — see
[Authoring portal.config.ts](/config-cli/portal-config#authentication).

## Logging in and out without remounting

`setToken` swaps the credential source for an already-running client:

```ts
import { Portal } from "@portalsdk/core";

async function fetchPortalToken(): Promise<string> {
  const res = await fetch("/api/portal-token", { credentials: "include" });
  const { token } = (await res.json()) as { token: string };
  return token;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

// On login:
portal.setToken(fetchPortalToken);

// On logout, back to anonymous:
portal.setToken(undefined);
```

Passing the same source again is a no-op. When the identity genuinely changes, every
live channel handle and the inbox re-authenticate in place — idle (unacquired) handles
simply pick up the new credential the next time they're acquired. No component needs to
remount for a login/logout to take effect.

In React, `PortalProvider`'s `token` prop forwards to `setToken` for you — see
[PortalProvider](/react/provider).

## Claims

Once connected, a channel's own verified identity is available at `room.me`:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.me; // { id: string; anon: boolean; claims: Record<string, unknown> } | undefined
```

`claims` reflects whatever your `auth.claimMap` (or Portal's own token minting) put
there.
