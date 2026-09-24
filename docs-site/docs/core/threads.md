# Threads

A reply is an ordinary message that names the message it answers. That id — the parent's
id — **is** the thread's id, and the first reply is what brings the thread into
existence. There is no create call, and there is no such thing as an empty thread.

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

async function reply(parentMessageId: string) {
  await room.send({
    content: { text: "replying to that" },
    threadParentId: parentMessageId,
  });
}
```

Replies ride the channel like everything else: they arrive on the same socket, in the
same stream, and they are part of `room.messages`. What narrows is *notification* — only
the thread's participants (whoever has posted in it, plus anyone mentioned) get an inbox
entry for a reply. Render a flat timeline by ignoring `threadParentId`, or filter it out
to keep replies off the main transcript.

## A lens over one thread

`channel.thread(id)` gives you a view narrowed to a single thread. It owns no connection
of its own — the channel handle's refcount still governs the socket — and the same id
always returns the same object:

```ts
import { Portal } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel<ChatMessage>("room-1");
room.acquire();

const thread = room.thread("msg_the_parent_id");

thread.messages; // replies in THIS thread only, oldest first
thread.hasPrevious;
thread.isLoadingPrevious;

async function open() {
  // The first subscription lazily fetches the thread's latest page.
  const unsubscribe = thread.subscribe(() => console.log(thread.messages.length));

  await thread.send({ content: { text: "no threadParentId needed here" } });
  await thread.loadPrevious(); // older replies in this thread only

  unsubscribe();
}
```

`thread.send()` supplies the `threadParentId` for you, so it takes the same input as
`channel.send()` minus that field. `loadPrevious()` pages the thread by its **own** dense
sequence — thread positions, not channel positions — and resolves `false` once it reaches
the thread's first reply.

Events are narrowed where narrowing makes sense: `message`, `mention` and `retract` fire
for this thread's replies only, while `presence`, `activity` and `status` are the
channel's own, because that's what they describe.

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

const thread = room.thread("msg_the_parent_id");
const off = thread.on("message", (msg) => console.log("reply:", msg.id));
off();
```

## Nesting

The message you reply to may itself be a reply, so threads nest. The depth cap is **8**
levels; a reply that would sit deeper is refused before it reaches your middleware:

```ts
import { Portal, BlockedError } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

function showToUser(_message: string) {}

async function replyDeep(parentMessageId: string) {
  try {
    await room.send({ content: { text: "…" }, threadParentId: parentMessageId });
  } catch (err) {
    if (err instanceof BlockedError && err.reason === "thread_depth_exceeded") {
      showToUser("This conversation is nested as deep as it goes.");
    } else {
      throw err;
    }
  }
}
```

A `threadParentId` the channel could not have minted yet is refused the same way with
`reason: "thread_parent_unknown"`. An id whose message has simply aged out of hot storage
is *not* refused — a thread must never become un-repliable because its root got old.

**Nothing bubbles.** A reply in a sub-thread never touches its parent thread's unread
count, or the channel's. If you want "14 new in this branch", you compute it — the
pointers below are there so you can.

## Which threads exist

`channel.threads()` reads the channel's thread registry: every thread, whether or not you
participate in it. This is enumeration — for a tree walk, a backend, an agent picking up
work. Your *own* threads, with unread counts, are the inbox's job instead.

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const room = portal.channel("room-1");
room.acquire();

async function walk() {
  const roots = await room.threads(); // root threads (same as { parent: null })
  for (const node of roots.threads) {
    console.log(node.id, node.depth, node.messageCount, node.spawnedBy.id);
  }

  const children = await room.threads({ parent: "msg_the_parent_id" }); // direct children
  const branch = await room.threads({ root: "msg_the_root_id" }); // whole branch, any depth

  console.log(children.threads.length, branch.threads.length);

  // Paging: next() carries the server's cursor. hasMore alone is not the signal to stop —
  // an exhausted page comes back empty.
  let page = roots;
  while (page.hasMore) {
    page = await page.next();
  }
}
```

A `ThreadNode`:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The thread id — the id of the message whose first reply created it. |
| `parentThreadId` | `string \| undefined` | The enclosing thread. Absent on a root thread. |
| `rootThreadId` | `string` | The top-level ancestor. Equals `id` on a root thread. |
| `depth` | `number` | Nesting level. **A root thread is depth `1`**, and the cap is `8`. |
| `spawnedBy` | `{ id: string }` | Who sent the message the thread hangs off. |
| `messageCount` | `number` | Replies in the thread. |
| `createdAt` | `number` | Epoch milliseconds. |

Nodes come back newest-spawned first. `depth` is 1-based, matching the wire and the HTTP
API — don't renormalize it client-side.

## Threads in the inbox

A thread you participate in gets its **own** inbox entry, sitting beside its channel's
entry rather than inside it: same `id`, its own `latest`, `unread`, read position and
`muted`. Identity is the pair `(id, threadId)`:

```ts
import { Portal } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });
const inbox = portal.inbox();

const channelEntry = inbox.channels.get("room-1"); // the channel's own entry, never a thread's
const threadEntry = inbox.channels.get("room-1", "msg_the_parent_id");

threadEntry?.unread;
threadEntry?.parentThreadId; // the enclosing thread, on a nested thread
threadEntry?.rootThreadId; // the top of the branch
threadEntry?.markAsRead(); // this thread only — never its parent, never its children
threadEntry?.mute();

console.log(channelEntry?.unread);
```

`parentThreadId` / `rootThreadId` are rendering pointers: nest the sidebar, sort within a
parent, pick the sub-thread with the newest activity. They imply no hierarchy in the
protocol — no entry's unread ever reflects another's. See [Inbox](/core/inbox).

## What threads don't change

- **Read position doesn't cascade.** Reading a thread reads that thread. Not its parent,
  not its children, not the channel.
- **Participation doesn't inherit.** Posting in a sub-thread joins that sub-thread. You
  are not thereby in its parent.
- **Presence and activity stay channel-wide.** There is no per-thread typing indicator:
  `sendTyping()` describes the room. If you need typing scoped to a thread, send it
  yourself on the ephemeral lane (see [Channels](/core/channels)).

If you're using React, [`useThread`](/react/use-thread) wraps the lens; the registry is a
promise rather than a store, so call `threads()` on the client you handed
[`PortalProvider`](/react/provider).
