# Guide: Webhooks

Portal can relay every channel message to a server you control — a signed HTTP `POST`
for each `message.published` and `message.retracted` event, independent of whether
anyone is connected to the channel at the time. Use it to fan messages out to a data
warehouse, trigger backend workflows, or keep a system of record in sync, without
running a WebSocket client of your own.

## Configure an endpoint

Set `webhooks` at the project level in `portal.config.ts` — it isn't a per-channel
setting, one endpoint covers every channel in the project:

```ts
// file: portal.config.ts
import { defineConfig } from "@portalsdk/config";

export default defineConfig({
  webhooks: {
    url: "https://api.yourapp.example.com/portal/webhooks",
  },
});
```

```sh
portal deploy
```

`portal deploy` validates the URL before uploading anything:

- **`https` only** — `http` is accepted solely for `localhost`, `127.0.0.1`, or `[::1]`,
  for local development.
- **No private or internal addresses** — RFC 1918 ranges (`10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`), link-local and loopback addresses, an
  `.internal`/`.localhost` hostname, and their IPv6 equivalents are all rejected.

A config that fails either check is refused at deploy time, not discovered later as
silently-failing deliveries. Set `webhooks` to `null` (or omit it) to disable delivery —
see [Authoring portal.config.ts](/config-cli/portal-config) for the rest of the config
surface, and [Deploy & secrets](/config-cli/deploy-and-secrets) for `portal deploy`
itself.

A per-environment signing secret is minted automatically the first time a
webhook-bearing config is activated — you don't provision it yourself. Fetch it with
`GET /v1/webhooks/secret` when you get to verification, below.

## Events

Two event types, one for every persisted message and one for every retraction:

| `type` | Fires when |
| --- | --- |
| `message.published` | A message is persisted to a channel (server or client publish). |
| `message.retracted` | A previously-published message is retracted. |

Every delivery is a JSON body shaped:

```json
{
  "id": "m_1752912000_42",
  "type": "message.published",
  "timestamp": 1752912000000,
  "environmentId": "env_abc123",
  "channelId": "chat-general",
  "data": {
    "id": "m_1752912000_42",
    "seq": 42,
    "type": "message",
    "kind": "text",
    "content": { "text": "hello world" },
    "sender": { "id": "u_123", "anon": false },
    "timestamp": 1752912000000,
    "retracted": false,
    "ephemeral": false
  }
}
```

- **`id`** — the event id. For `message.published` this is the message id; for
  `message.retracted` it's `retract_{messageId}` (a distinct id from the publish event,
  since it's a separate delivery).
- **`timestamp`** — epoch milliseconds.
- **`environmentId`** / **`channelId`** — where the event happened.
- **`data`** — the message envelope itself, in the exact shape documented in
  [Wire protocol → Frames on the channel socket](/wire-protocol#frames-on-the-channel-socket)
  (`id`, `seq`, `type`, `kind`, `content`, `sender`, `timestamp`, optional `to`/`mentions`,
  `retracted`, `ephemeral`). Ephemeral messages are never delivered as webhooks — there's
  nothing persisted to relay.

For `message.retracted`, `data` is that same envelope in its tombstoned form —
`retracted: true`, `content: null` — matching how a retraction already appears in
`GET /v1/channels/{channelId}/history`. It does **not** carry a retraction `reason`; that
field belongs to the wire-level `retract` frame, not the message envelope, so it isn't
part of the webhook payload in v1.

## Verifying signatures

**Do this before processing any delivery.** Every request carries a `portal-signature`
header:

```
portal-signature: t=1752912000,v1=3f9a2b1c...
```

`t` is the signing timestamp (Unix seconds); `v1` is the hex-encoded
`HMAC-SHA256(secret, "{t}.{rawBody}")`, where `rawBody` is the exact request body bytes
Portal sent — not a re-serialized version of the parsed JSON, which is not guaranteed to
match byte-for-byte. Most frameworks parse the body before your handler runs, so make
sure you capture the raw bytes (e.g. Express's `express.raw({ type: "application/json" })`
ahead of your route, rather than the default JSON body parser).

Fetch the secret with a secret key, server-side:

```
GET /v1/webhooks/secret
Authorization: Bearer sk_your_secret_key
```

It returns `{ "secret": "whsec_..." }` — cache it; it's stable across deploys and only
changes if you rotate it. `404` means no webhook secret exists yet for the environment
(webhooks aren't configured).

A complete verification function, constant-time comparison and timestamp tolerance
included:

```ts
// file: verify-webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader) {
    throw new WebhookVerificationError("Missing portal-signature header.");
  }

  const parts = new Map<string, string>();
  for (const pair of signatureHeader.split(",")) {
    const [key, value] = pair.split("=");
    if (key && value) parts.set(key, value);
  }

  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) {
    throw new WebhookVerificationError("Malformed portal-signature header.");
  }

  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("Signature timestamp outside tolerance.");
  }

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const providedBytes = Buffer.from(v1, "hex");

  const signatureMatches =
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);

  if (!signatureMatches) {
    throw new WebhookVerificationError("Signature does not match.");
  }
}
```

The tolerance window (5 minutes above — pick whatever fits your clock skew and network
conditions) rejects replayed deliveries whose timestamp has aged out, even if the
signature itself still matches. Reject anything that fails verification with a non-2xx
response and do not process its body.

## Delivery model

Delivery is **at-least-once**: a delivery that fails is retried on a backoff schedule —
30s, 5m, 30m, 2h, 6h — and marked `dropped` if every attempt fails. Because retries and
occasional redelivery are both possible, **dedupe on the top-level `id`** before acting
on an event, not on a request-level property of your own:

```ts
// file: webhook-handler.ts
import { verifyWebhookSignature, WebhookVerificationError } from "./verify-webhook";

interface WebhookEvent {
  id: string;
  type: "message.published" | "message.retracted";
  timestamp: number;
  environmentId: string;
  channelId: string;
  data: unknown;
}

declare function alreadyProcessed(eventId: string): Promise<boolean>;
declare function markProcessed(eventId: string): Promise<void>;
declare function handle(event: WebhookEvent): Promise<void>;

async function onWebhookRequest(rawBody: string, signatureHeader: string | undefined, secret: string) {
  try {
    verifyWebhookSignature(rawBody, signatureHeader, secret);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return { status: 401 as const };
    }
    throw err;
  }

  const event = JSON.parse(rawBody) as WebhookEvent;
  if (await alreadyProcessed(event.id)) {
    return { status: 200 as const }; // already handled — ack without reprocessing
  }

  await handle(event);
  await markProcessed(event.id);
  return { status: 200 as const };
}
```

Inspect delivery history directly rather than only relying on your own logs:

```
GET /v1/webhooks/deliveries?status=dropped&limit=50
Authorization: Bearer sk_your_secret_key
```

Each row carries `status` (`pending` / `delivered` / `dropped`), `attempts`, `lastError`,
and `nextAttemptAt` where relevant — the delivery ledger is itself the dead-letter store
for anything that exhausted its retries. `delivered` and `dropped` rows are retained for
roughly 7 days; filter with `status` and page with `limit` (default 50, max 500).
