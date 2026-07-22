# Authoring portal.config.ts

`@portalsdk/config` gives you type-safe authoring for your Portal config file —
channels, authorization, message middleware, and notifications — all checked and
autocompleted as you write them.

```bash
npm install -D @portalsdk/config
```

Create a `portal.config.ts` at the root of your project and export a config from
`defineConfig`:

```ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  channels: {
    "room-*": { anonymous: false },
  },
});
```

Every channel works with no configuration at all — a channel with no matching entry
uses the defaults (standard mode, anonymous access allowed, no authorization, no
middleware). Config entries exist only to override specific channels, so an empty
config, or no config file at all, is perfectly valid.

## Channels

Keys are either an exact channel id or a template ending in `*`:

```ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  channels: {
    announcements: { mode: "broadcast" }, // exact id
    "room-vip-*": { anonymous: false }, // most specific template wins
    "room-*": { anonymous: true },
  },
});
```

When more than one key could match a channel, the exact id wins; otherwise the most
specific template does (the one with the longest fixed prefix).

Each channel accepts:

| Field | Meaning |
| --- | --- |
| `mode` | `"standard"` (default) or `"broadcast"`. Fixed when a channel is first created. |
| `anonymous` | Whether anonymous users may connect. Defaults to `true`. |
| `authz` | Authorize each connection and assign its capabilities. |
| `onPublish` | Middleware run on every published message. |
| `onDisconnect` | Callbacks run when a connection ends. |
| `notify` | Turn selected messages into notifications. |
| `extensions` | Attach extensions to the channel. |

## Authentication

By default, tokens are minted by Portal. To verify JWTs you issue yourself, add an
`auth` block and map your token's claims onto Portal identity fields:

```ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  auth: {
    issuer: "https://your-app.example.com",
    jwksUrl: "https://your-app.example.com/.well-known/jwks.json",
    claimMap: {
      userId: "sub", // required
      username: "name",
      anon: "public_metadata.guest",
    },
  },
});
```

Only `userId` is required. Add further entries to map additional claims by dotted path.
This is the config-side counterpart of what a client hands the SDK as `token` — see
[Tokens & auth](/core/tokens-and-auth).

## Authorization

An `authz` callback runs once, when a user connects. Return `allow(capabilities)` to
admit them with a fixed set of permissions, or `block(reason)` to refuse:

```ts
import { defineConfig, allow, block } from "@portalsdk/config";

export default defineConfig({
  channels: {
    "room-*": {
      authz: (ctx) => {
        if (ctx.claims.anon) return block("Sign in to join this room.");
        return allow({ publish: true, sendDirect: true });
      },
    },
  },
});
```

Capabilities are your source of truth for what a session may do. Alongside the built-in
`publish` and `sendDirect` flags you can add your own named capabilities and read them
later in middleware — Portal carries them for you. Roles and permissions are entirely
yours: they live only inside this callback and in the capabilities you return.

If an `authz` callback throws or times out, the connection is refused — always.

## Message middleware

`onPublish` middleware run in order on every published message. Each step returns
`allow()`, `block(reason)`, or `mask(content)`, and the first step that does not
`allow()` ends the chain:

```ts
import { defineConfig, defineMiddleware, allow, block, mask } from "@portalsdk/config";

interface ChatMessage {
  body: string;
}

const moderate = defineMiddleware<ChatMessage>("publish", (ctx) => {
  if (!ctx.capabilities.publish) {
    return block("You do not have permission to post here.");
  }

  const text = ctx.message.content.body;
  if (text.includes("badword")) {
    return mask<ChatMessage>({ body: text.replaceAll("badword", "****") });
  }

  return allow();
});

export default defineConfig({
  channels: {
    "room-*": { onPublish: [moderate] },
  },
});
```

- **`block(reason)`** stops the message. The reason is shown to the sender (it surfaces
  client-side as `BlockedError.reason` — see [Errors](/core/errors)), so write it as
  end-user copy.
- **`mask(content)`** lets the message through but replaces its content before anyone
  sees it. The replacement flows to the rest of the chain and every recipient; the
  original content is not stored.

### Deferred work and retracting

Register `defer()` work to run after a message is delivered. A deferred callback may
return `retract()` to take the message back — recipients replace it in place, and it is
left out of history and replay:

```ts
import { defineMiddleware, allow, retract } from "@portalsdk/config";

defineMiddleware("publish", (ctx) => {
  ctx.defer(async () => {
    if (await isSpam(ctx.message)) return retract("Removed after review.");
  });
  return allow();
});

async function isSpam(_message: unknown): Promise<boolean> {
  return false;
}
```

Use `notify()` for fire-and-forget follow-up work once the outcome is final:

```ts
import { defineMiddleware, allow } from "@portalsdk/config";

defineMiddleware("publish", (ctx) => {
  ctx.notify(async (outcome) => {
    if (outcome.action === "block") await log(outcome.reason);
  });
  return allow();
});

async function log(_reason: string) {}
```

### Disconnect callbacks

`onDisconnect` callbacks run when a connection ends. They observe only — they cannot
reject anything:

```ts
import { defineMiddleware } from "@portalsdk/config";

const onLeave = defineMiddleware("disconnect", (ctx) => {
  ctx.notify(async () => track(ctx.sender.id, ctx.reason));
});

async function track(_userId: string, _reason: string) {}
```

## Notifications

A `notify` bridge turns selected messages into notifications for their recipients.
Return a descriptor to create one, or `null` to leave the message as an ordinary
message:

```ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  channels: {
    "room-*": {
      notify: (ctx) => {
        const mentions = ctx.message.mentions ?? [];
        if (mentions.length === 0) return null;
        return {
          title: "You were mentioned",
          data: { messageId: ctx.message.id },
          to: mentions.map((m) => m.userId),
        };
      },
    },
  },
});
```

By default the recipient is the message's `to`; set `to` on the descriptor to override
or fan out to several users. Each notification a `notify` bridge creates is what shows
up client-side as an `InboxItem` — see [Inbox](/core/inbox).

## Secrets

Read a project secret from inside a callback with `env()`. Set secrets with
`portal secrets set NAME` (see [Deploy & secrets](/config-cli/deploy-and-secrets)); the
value is resolved when your deployed callbacks run and is never written into your
configuration:

```ts
import { defineMiddleware, allow, block, env } from "@portalsdk/config";

defineMiddleware("publish", async (ctx) => {
  const flagged = await moderate(ctx.message.content, env("MODERATION_API_KEY"));
  return flagged ? block("This message was held for review.") : allow();
});

async function moderate(_content: unknown, _apiKey: string): Promise<boolean> {
  return false;
}
```

`env()` throws `MissingSecretError` if the named secret has not been set.

## Extensions

Extensions add their own message types to a channel. Attach one by mapping a handle you
choose to the source file that implements it:

```ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  channels: {
    "room-*": {
      extensions: {
        polls: "src/extensions/polls.ts",
      },
    },
  },
});
```

An extension declares what it owns through a static manifest. Use `defineExtension` so
that manifest is type-checked:

```ts
import {
  defineExtension,
  type BatchRequest,
  type ExtensionManifest,
} from "@portalsdk/config";

class Polls {
  static manifest: ExtensionManifest = {
    namespace: "poll.", // every message type this extension owns starts with "poll."
    transport: "ws",
  };

  // The one required handler: Portal calls it with each batch of messages
  // published to this namespace. See the extensions guide for a complete example.
  async onBatch({ messages }: BatchRequest) {
    for (const message of messages) {
      console.log(message.type, message.content);
    }
  }
}

export default defineExtension(Polls);
```

## Typing message content

Pass your message type to `defineMiddleware` to type `ctx.message.content`:

```ts
import { defineMiddleware, allow } from "@portalsdk/config";

interface ChatMessage {
  body: string;
  attachments?: string[];
}

defineMiddleware<ChatMessage>("publish", (ctx) => {
  ctx.message.content.body; // typed as string
  return allow();
});
```
