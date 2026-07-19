# Errors

Every failure the SDK surfaces is a `PortalError` — carrying a stable, machine-readable
`code` you can safely branch on — or one of its named subclasses, for the failures a
caller typically reacts to differently:

```ts
import {
  PortalError,
  InvalidApiKeyError,
  BlockedError,
  TokenExpiredError,
  NotMemberError,
  ChannelAtCapacityError,
  AnonymousNotAllowedError,
  NotYetSupportedError,
  DegradedError,
} from "@portalsdk/core";
```

| Class | `code` | When |
| --- | --- | --- |
| `InvalidApiKeyError` | `"invalid_api_key"` | A bad or unknown `apiKey`. Terminal — `status` goes to `"blocked"`, no reconnect loop. |
| `BlockedError` | `"blocked"` | A gate or your own `portal.config.ts` middleware refused a send. Carries `reason` — end-user-visible copy. |
| `TokenExpiredError` | `"token_expired"` | The token was rejected as expired. A callback token is re-resolved once and retried; a still-failing retry, or a static string token, surfaces this. |
| `NotMemberError` | `"not_member"` | A membership channel with no row for this user — on connect, or on a `to:`-send. |
| `ChannelAtCapacityError` | `"channel_at_capacity"` | The channel refused admission at its hard cap. |
| `AnonymousNotAllowedError` | `"anonymous_not_allowed"` | The channel is configured `anonymous: false` and the token is anonymous. |
| `NotYetSupportedError` | `"not_yet_supported"` | A reserved surface was used (e.g. a `where` filter pushed to the server, attachments, non-text media). Typed but rejected loudly. |
| `DegradedError` | `"degraded"` | A send into an extension namespace whose extension is currently degraded; the channel itself keeps working. |

## Handling send failures

`send()` rejects with the relevant error:

```ts
import { Portal, BlockedError, PortalError } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

function showToUser(_message: string) {}

async function sendMessage() {
  try {
    await room.send({ content: { text: "hello" } });
  } catch (err) {
    if (err instanceof BlockedError) {
      showToUser(err.reason); // end-user-visible copy from your middleware or the platform
    } else if (err instanceof PortalError) {
      console.error(err.code, err.message);
    } else {
      throw err;
    }
  }
}
```

## Connection-level refusals

Refusals that aren't tied to a single `send()` call — a bad API key, being banned, not
being a member, hitting channel capacity — arrive on the `status` event instead, and
move `room.status` to `"blocked"`:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.on("status", (status, error) => {
  if (status === "blocked" && error) {
    console.error("channel blocked:", error.code, error.message);
  }
});
```

`"blocked"` is terminal for that handle: there's no reconnect loop once it fires.
