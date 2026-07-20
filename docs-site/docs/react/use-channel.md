# useChannel

`useChannel` subscribes a component to one channel. It's a thin binding over the core
`ChannelHandle`: it resolves the handle from the registry, drives the refcount from
mount/unmount, and mirrors the handle's store through `useSyncExternalStore`. All state
lives in core — the hook owns none of it.

```tsx
import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function ChatRoom({ channelId }: { channelId: string }) {
  const { messages, send, status } = useChannel<ChatMessage>({ channelId });

  return (
    <div>
      <p>status: {status}</p>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.content.text}</li>
        ))}
      </ul>
      <button onClick={() => send({ content: { text: "hello" } })}>Send</button>
    </div>
  );
}
```

## Params

| Param | Type | Notes |
| --- | --- | --- |
| `channelId` | `string \| undefined` | `undefined` renders inert and opens no connection — the two-pane "nothing selected" pattern. Changing the id releases the old handle and acquires the new one. |
| `readOn` | `"mount" \| "visible" \| "manual"` | When the channel watermark auto-advances. Default `"mount"`. `"visible"` advances on mount if the document is visible, then again on each `visibilitychange` → visible while mounted. `"manual"` never auto-advances — call `markAsRead()` yourself. |
| `history` | `number \| "none"` | Initial backfill on connect. Default `50`. |
| `metadata` | `Record<string, unknown>` | Initial presence metadata for this session. |
| `where` | `MessageWhere<M>` | Reserved surface — typed, but rejected at runtime in v1 (`NotYetSupportedError`). |
| `onMention` | `(msg: Message<M>) => void` | Called when a message's `mentions` include you. |
| `onMessage` | `(msg: Message<M>) => void` | Called on every message delivered to this channel, persistent or ephemeral. |
| `onError` | `(err: PortalError) => void` | Called on channel errors. |

### The two-pane pattern

```tsx
import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function ChannelPane({ channelId }: { channelId: string | undefined }) {
  const { messages } = useChannel<ChatMessage>({ channelId });

  if (channelId === undefined) {
    return <p>Select a channel</p>;
  }

  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.content.text}</li>
      ))}
    </ul>
  );
}
```

Because `useChannel` itself tolerates `channelId: undefined`, you can call it
unconditionally at the top of a component even before a selection exists — no need to
branch above the hook call.

## Result

`useChannel` returns `UseChannelResult<M>`: `messages`, `send`, `loadPrevious`,
`isLoadingPrevious`, `hasPrevious`, `channel`, `me`, `presence`, `activity`,
`sendActivity`, `typing`, `sendTyping`, `unread`, `markAsRead`, `setMetadata`, and
`status` — mirroring the [core channel surface](/core/channels) field-for-field. Import
the type directly if you want to name it, e.g. to type a prop:

```tsx
import type { UseChannelResult } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function MessageList({ messages }: { messages: UseChannelResult<ChatMessage>["messages"] }) {
  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.content.text}</li>
      ))}
    </ul>
  );
}
```

## Typing indicators

```tsx
import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function Composer({ channelId }: { channelId: string }) {
  const { typing, sendTyping, send } = useChannel<ChatMessage>({ channelId });

  return (
    <div>
      {typing.length > 0 && <p>{typing.join(", ")} typing…</p>}
      <input onChange={() => sendTyping()} />
      <button onClick={() => send({ content: { text: "hi" } })}>Send</button>
    </div>
  );
}
```

## Reacting to mentions and errors

```tsx
import { useChannel } from "@portalsdk/react";
import type { PortalError } from "@portalsdk/core";

interface ChatMessage {
  text: string;
}

function ChatRoom({ channelId }: { channelId: string }) {
  const { messages } = useChannel<ChatMessage>({
    channelId,
    onMention: (msg) => console.log("mentioned in:", msg.content.text),
    onError: (err: PortalError) => console.error(err.code, err.message),
  });

  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.content.text}</li>
      ))}
    </ul>
  );
}
```

## Reacting to every message, and updating presence metadata

`onMessage` fires on every message delivered to the channel — persistent or ephemeral —
which is the right tool for high-frequency ephemeral traffic (live cursors, transient
signals) that you want to react to as discrete events rather than read off the accumulated
`messages` array. `setMetadata` replaces your own presence metadata mid-session — a direct
pass-through to the channel handle's `setMetadata`:

```tsx
import type { PointerEvent } from "react";
import { useChannel } from "@portalsdk/react";

interface CursorPosition {
  x: number;
  y: number;
}

function LiveCursor({ channelId }: { channelId: string }) {
  const { setMetadata, send } = useChannel<CursorPosition>({
    channelId,
    onMessage: (msg) => {
      if (msg.ephemeral) console.log("cursor from", msg.sender.id, msg.content);
    },
  });

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const position = { x: e.clientX, y: e.clientY };
    void send({ ephemeral: true, content: position });
    setMetadata({ cursor: position });
  }

  return <div onPointerMove={onPointerMove} style={{ width: "100%", height: "100%" }} />;
}
```

See [Guides → Live cursors](/guides/live-cursors) for the full pattern, including why you'd
combine ephemeral sends with throttled presence metadata rather than using just one.
