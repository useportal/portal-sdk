# Channels

A channel is a room: a seq-ordered stream of messages, plus presence, activity, and
read state, shared by everyone connected to the same channel id. Get a handle with
`portal.channel(id, options?)` — the same id always returns the same handle, so many
views of a room share one socket.

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1", { history: 50 });
room.acquire();
```

`ChannelOptions`:

| Field | Type | Notes |
| --- | --- | --- |
| `history` | `number \| "none"` | Initial backfill on connect. Default `50`. `"none"` starts live-only. |
| `metadata` | `Record<string, unknown>` | Initial presence metadata for this session — see [Presence](#presence). |

## Sending messages

`send()` takes either a persistent message (stored, appears in history, gets a `seq`) or
an ephemeral one (fire-and-forget — no persistence, no `seq`, never appears in history):

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

async function examples() {
  // Persistent — stored, ordered, shows up in history and for late joiners.
  const ack = await room.send({ content: { text: "hello" } });
  console.log(ack.id, ack.timestamp);

  // Directed to one member only, and mentioning another.
  await room.send({
    content: { text: "@alice you're up" },
    to: "user_alice",
    mentions: [{ userId: "user_alice" }],
  });

  // Ephemeral — never stored, no seq, no history. Good for cursors and transient signals.
  await room.send({ ephemeral: true, content: { text: "typing-like signal" } });
}
```

`send()` rejects with a `PortalError` subclass when the platform or your own
`portal.config.ts` middleware refuses the message — see [Errors](/core/errors).

## Reading messages and history

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

room.messages; // readonly Message<M>[], seq-ordered, mutations (retractions) applied in place

room.hasPrevious; // true until loadPrevious() reaches the beginning of the channel
room.isLoadingPrevious;

async function loadOlder() {
  await room.loadPrevious(); // fetch an older page; returns false once exhausted
}
```

`room.messages` starts with the initial backfill from `history` (or empty, under
`"none"`) and grows as new messages arrive; `loadPrevious()` pages further back.

You can also take a filtered, live lens over the same store without opening a second
socket:

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

const mentionsOnly = room.view({ type: { eq: "mention" } });
mentionsOnly.messages;
mentionsOnly.subscribe(() => console.log(mentionsOnly.getSnapshot().messages.length));
```

## Read state

Every channel tracks a **watermark** — how far *this device* has read, independent of
the inbox's own per-channel read state (see [Inbox](/core/inbox) for that distinction):

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.unread; // number
room.markAsRead(); // advances the channel watermark
```

## Presence

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.presence; // DetailedPresence | AggregatePresence | undefined
```

Small/standard channels get `DetailedPresence` (`{ kind: "detailed", participants, count }`);
larger ones get `AggregatePresence` (`{ kind: "aggregate", count, recent }`) with only
join/leave deltas, not a full roster. Either way, check `presence.kind` to narrow:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

const p = room.presence;
if (p?.kind === "detailed") {
  console.log(p.participants.map((u) => u.id));
} else if (p?.kind === "aggregate") {
  console.log(p.count, p.recent);
}
```

Replace your own presence metadata mid-session with `setMetadata` — this is
presentation-only, never used for authorization:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.setMetadata({ cursor: { x: 120, y: 48 } });
```

## Activity (typing indicators, and beyond)

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

room.activity; // readonly ActivityEntry[] — other users' current activity, never your own
room.sendActivity("typing"); // any string kind; SDK throttles automatically

// Sugar for the common case:
room.typing; // readonly string[] of user ids currently typing
room.sendTyping(); // sendActivity("typing")
```

`sendActivity`/`sendTyping` are a no-op on broadcast channels.

## Members and channel info

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

async function inspect() {
  const members = await room.members(); // MemberRow[] — fetched directory, not live state
  console.log(members);
}

room.info; // ChannelInfo | undefined — id, mode ("standard" | "broadcast"), name?, meta?
room.me; // { id, anon, claims } | undefined — your own verified identity, once connected
```

## Status and events

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

room.status; // "idle" | "connecting" | "ready" | "reconnecting" | "degraded" | "degraded-http" | "blocked"

const unsubscribe = room.on("message", (msg) => console.log(msg.content));
room.on("mention", (msg) => console.log("mentioned:", msg));
room.on("retract", (messageId) => console.log("retracted:", messageId));
room.on("presence", (p) => console.log(p));
room.on("activity", (entries) => console.log(entries));
room.on("status", (status, error) => console.log(status, error));

unsubscribe();
```

`"degraded-http"` means the socket is down and reconnecting, but HTTP publish still
works — you can still send, incoming messages may lag until reconnect gap-fill catches
up. `"blocked"` is terminal (bad key, banned, not a member, at capacity) — see
[Errors](/core/errors).

## Store contract

`ChannelHandle` (and the filtered `ChannelView` from `view()`) exposes a
`useSyncExternalStore`-shaped contract directly, so you can bind it to any UI layer, not
just React:

```ts
import { Portal } from "@portalsdk/core";
import type { ChannelSnapshot } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

function render(_snapshot: ChannelSnapshot) {}

room.subscribe(() => render(room.getSnapshot()));
```

If you're using React, [`useChannel`](/react/use-channel) wraps all of this for you.
