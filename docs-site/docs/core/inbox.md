# Inbox

The inbox is a per-user, cross-channel feed: mentions, direct sends, and anything a
`notify` bridge in `portal.config.ts` turns into a notification (see
[Authoring portal.config.ts](/config-cli/portal-config)). Get it with `portal.inbox()` —
a lazy singleton, created and connected on first call:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();
```

Anonymous users get a permanently-empty, ready inbox — there's nothing to fetch for an
identity that doesn't persist across sessions.

## Two kinds of state: channels and items

`InboxHandle` tracks two related but distinct things:

- **`channels`** — one entry per channel you have activity in, positional (a watermark +
  an unread count), recency-sorted.
- **`items`** — individual targeted events (mentions, directed sends, notify
  descriptors), each with its own per-item read state.

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

inbox.channels; // InboxEntries — recency-sorted; .get(id) always hits the full registry
inbox.items; // readonly InboxItem[]
inbox.counter; // number — the global badge: Σ channel unreads + unseen items
```

`counter` excludes muted channels' ordinary unreads, but **not** items addressed to you
— a mention in a muted room still contributes to the badge, because muting silences
aggregation, not delivery.

### Channel entries

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

const entry = inbox.channels.get("room-1");
entry?.unread; // latestSeq − your watermark for this channel
entry?.markAsRead(); // advances the INBOX position for this channel only
entry?.mute();
entry?.unmute();
```

`entry.markAsRead()` is independent of the channel's own watermark
(`room.markAsRead()` from [Channels](/core/channels)) — the inbox tracks *noticing*, the
channel tracks *reading*, and the two are allowed to disagree.

### Items

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

for (const item of inbox.items) {
  console.log(item.id, item.type, item.title, item.data, item.read);
  item.markAsRead(); // flips THIS item only, never cascades to older items
}

inbox.markAllRead(); // global, zero-argument: marks every item read
```

Each `item.id` is the event's idempotency key — stable across redelivery, so it's the
right thing to key a React list (or a dedup set) on. See
[In-app notifications](/guides/in-app-notifications) for a worked example.

## Filtered views

`inbox.view(query)` gives you a scoped, live lens without a second connection:

```ts
import { Portal } from "@portalsdk/core";

interface AssignmentPayload {
  ticketId: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

const assignments = inbox.view<AssignmentPayload>({
  where: { type: { eq: "ticket.assigned" } },
});

assignments.items; // readonly InboxItem<AssignmentPayload>[]
assignments.unseen; // unseen count scoped to THIS view's filter (unlike inbox.counter)
assignments.subscribe(() => console.log(assignments.getSnapshot().items.length));
```

You can also scope a view to one channel:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

const roomInbox = inbox.view({ channelId: "room-1" });
```

## Reacting to new items

`InboxHandle` emits an `"item"` event whenever a new item arrives — useful for toasts and
other one-shot reactions, as opposed to reading the accumulated `items` array:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

const unsubscribe = inbox.on("item", (item) => {
  console.log("new inbox item:", item.type, item.data);
});

inbox.on("change", () => {
  // fires on any state change to channels/items/counter
});

unsubscribe();
```

If you're using React, [`useInbox`](/react/use-inbox)'s `onItem` param wraps this event
directly — no need to reach for the core client yourself.

## Store contract

Like channels, `InboxHandle` and `InboxView` are `useSyncExternalStore`-shaped:

```ts
import { Portal } from "@portalsdk/core";
import type { InboxSnapshot } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

function render(_snapshot: InboxSnapshot) {}

inbox.subscribe(() => render(inbox.getSnapshot()));
inbox.getSnapshot(); // { channels, items, counter, status }
inbox.status; // InboxStatus: "connecting" | "ready" | "reconnecting" (a live inbox is never "idle" — see below)
```

`InboxStatus` also includes `"idle"`, for consumers that model a handle that hasn't been
created at all — `portal.inbox()` itself is never `"idle"` (it's at least `"connecting"` from
the moment it's created); `@portalsdk/react`'s SSR-inert `useInbox` is the one place that
value actually appears (see [SSR & Next.js](/core/ssr-and-nextjs)).

If you're using React, [`useInbox`](/react/use-inbox) wraps the global handle and a
filtered view together.
