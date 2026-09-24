# useThread

`useThread` subscribes a component to one thread of a channel. It's a selector over
core's [`ThreadHandle`](/core/threads): it resolves the *channel* handle from the
registry, holds that channel's refcount while mounted — so a thread view shares the
channel's socket, and opens it if nothing else has — and mirrors the lens through
`useSyncExternalStore`.

```tsx
import { useThread } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function ThreadPane({ channelId, threadId }: { channelId: string; threadId: string }) {
  const { messages, send, status } = useThread<ChatMessage>({ channelId, threadId });

  return (
    <div>
      <p>status: {status}</p>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.content.text}</li>
        ))}
      </ul>
      <button onClick={() => send({ content: { text: "reply" } })}>Reply</button>
    </div>
  );
}
```

`send` needs no `threadParentId` — the hook supplies it.

The lens hands back the same snapshot while this thread is unchanged, so unrelated
channel traffic — another thread's reply, presence, a typing indicator — doesn't
re-render this component.

## Params

`UseThreadParams` is [`UseChannelParams`](/react/use-channel#params) plus `threadId`:

| Param | Type | Notes |
| --- | --- | --- |
| `channelId` | `string \| undefined` | As on `useChannel` — `undefined` renders inert and opens nothing. |
| `threadId` | `string` | The thread: the id of the message it hangs off. |
| `history` | `number \| "none"` | Page size for the thread's own backfill. Default `50`. |
| `readOn` | `"mount" \| "visible" \| "manual"` | **No effect here.** A thread has no watermark of its own, and reading a thread never advances the channel's — per-thread read state lives on the [inbox entry](/core/threads#threads-in-the-inbox). |
| `where` | `MessageWhere<M>` | Reserved, as on the channel: typed, rejected at runtime. |
| `onMessage` / `onMention` | `(msg: Message<M>) => void` | Fire for **this thread's** replies only. |
| `onError` | `(err: PortalError) => void` | Channel errors. |

## Result

| Field | Type | Notes |
| --- | --- | --- |
| `messages` | `readonly Message<M>[]` | Replies in this thread only, oldest first. |
| `send` | `(input) => Promise<SendAck>` | Replies into this thread. Rejects `BlockedError` with `reason: "thread_depth_exceeded"` past the 8-level cap. |
| `loadPrevious` | `() => Promise<boolean>` | Older replies in this thread only. |
| `hasPrevious` | `boolean` | `false` once the thread's first reply is reached. |
| `isLoadingPrevious` | `boolean` | |
| `status` | `ChannelStatus` | The **channel's** connection status — a thread rides the channel's socket. |

There's deliberately no presence, activity or `unread` here: those describe the room, not
the thread. Read them from [`useChannel`](/react/use-channel) alongside.

## A channel and a thread, side by side

Mounting both is the normal case — they share one socket, and the channel keeps its own
read state while the thread pane scrolls independently:

```tsx
// file: ChannelWithThread.tsx
import { useState } from "react";
import { useChannel, useThread } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

export function ChannelWithThread({ channelId }: { channelId: string }) {
  const [openThread, setOpenThread] = useState<string | undefined>(undefined);
  const { messages } = useChannel<ChatMessage>({ channelId });

  return (
    <div>
      <ul>
        {messages
          .filter((m) => m.threadParentId === undefined)
          .map((m) => (
            <li key={m.id}>
              {m.content.text}
              <button onClick={() => setOpenThread(m.id)}>Open thread</button>
            </li>
          ))}
      </ul>
      {openThread !== undefined ? <Replies channelId={channelId} threadId={openThread} /> : null}
    </div>
  );
}

function Replies({ channelId, threadId }: { channelId: string; threadId: string }) {
  const { messages, loadPrevious, hasPrevious } = useThread<ChatMessage>({
    channelId,
    threadId,
  });

  return (
    <aside>
      {hasPrevious ? <button onClick={() => loadPrevious()}>Load older</button> : null}
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.content.text}</li>
        ))}
      </ul>
    </aside>
  );
}
```

Nesting is the same component one level down: a reply's own id is a thread id, so render
`Replies` with `threadId={reply.id}`, up to the platform's 8-level cap.

## Enumerating threads

There's no `useThreads` hook. The registry is a paged promise, not a reactive store, so
call it on the client you handed [`PortalProvider`](/react/provider):

```tsx
// file: ThreadList.tsx
import { useEffect, useState } from "react";
import { Portal } from "@portalsdk/core";
import type { ThreadNode } from "@portalsdk/core";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

export function ThreadList({ channelId }: { channelId: string }) {
  const [threads, setThreads] = useState<readonly ThreadNode[]>([]);

  useEffect(() => {
    let live = true;
    portal
      .channel(channelId)
      .threads()
      .then((page) => {
        if (live) setThreads(page.threads);
      });
    return () => {
      live = false;
    };
  }, [channelId]);

  return (
    <ul>
      {threads.map((t) => (
        <li key={t.id}>
          depth {t.depth} · {t.messageCount} replies
        </li>
      ))}
    </ul>
  );
}
```

`threads()` doesn't need the channel acquired — it's an HTTP read, not a subscription.
For the sidebar of threads *you* are in, with unread counts, use
[`useInbox`](/react/use-inbox) and read each entry's `threadId` instead; see
[Threads](/core/threads#threads-in-the-inbox).
