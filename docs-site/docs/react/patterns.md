# Patterns

A few shapes that come up often when wiring `@portalsdk/react` into a real app.

## One client, at the top of the tree

Construct the `Portal` client once, outside your component tree (module scope), and
provide it once at the root. `PortalProvider` is passive — it just publishes the client
on context — so nesting more than one is rarely useful; a single provider near your app
root is enough for every `useChannel`/`useInbox` call beneath it.

```tsx
import type { ReactNode } from "react";
import { Portal } from "@portalsdk/core";
import { PortalProvider } from "@portalsdk/react";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

function AppRoot({ children }: { children: ReactNode }) {
  return <PortalProvider client={portal}>{children}</PortalProvider>;
}
```

## Switching channels without unmounting the shell

Since `channelId: undefined` renders `useChannel` inert, a channel switcher can hold the
selection in state and let the hook track it — no manual `acquire`/`release`, and no
remount of the surrounding layout:

```tsx
import { useState } from "react";
import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function ChannelSwitcher() {
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const { messages } = useChannel<ChatMessage>({ channelId });

  return (
    <div>
      <nav>
        {["general", "random", "help"].map((id) => (
          <button key={id} onClick={() => setChannelId(id)}>
            {id}
          </button>
        ))}
      </nav>
      {channelId === undefined ? (
        <p>Pick a channel</p>
      ) : (
        <ul>
          {messages.map((m) => (
            <li key={m.id}>{m.content.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Changing `channelId` releases the old handle and acquires the new one automatically.

## Watching several channels at once

Each `useChannel` call is independent, so a sidebar of live-updating room previews is
just one hook call per row:

```tsx
import { useChannel } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function RoomPreview({ channelId }: { channelId: string }) {
  const { messages, unread } = useChannel<ChatMessage>({ channelId, readOn: "manual" });
  const last = messages[messages.length - 1];

  return (
    <div>
      <strong>{channelId}</strong> {unread > 0 && <span>({unread})</span>}
      <p>{last?.content.text ?? "No messages yet"}</p>
    </div>
  );
}

function Sidebar({ channelIds }: { channelIds: string[] }) {
  return (
    <>
      {channelIds.map((id) => (
        <RoomPreview key={id} channelId={id} />
      ))}
    </>
  );
}
```

Each preview opens its own connection for as long as it's mounted — since
`portal.channel(id)` is a lookup-or-create keyed by id, a preview and a full open room
for the same channel share the same underlying socket rather than opening a second one.
`readOn: "manual"` keeps a preview from silently clearing its own unread badge just by
being on screen.

## Pairing a channel view with the inbox badge

`useChannel`'s `unread` and `useInbox`'s per-channel entry are two different read
positions — see [Inbox](/core/inbox#channel-entries) for why. A typical room header shows
the channel's own unread count while active, and clears the inbox's notice for that
channel on open:

```tsx
import { useEffect } from "react";
import { useChannel, useInbox } from "@portalsdk/react";

interface ChatMessage {
  text: string;
}

function RoomHeader({ channelId }: { channelId: string }) {
  const { unread } = useChannel<ChatMessage>({ channelId });
  const { channels } = useInbox();

  useEffect(() => {
    channels.get(channelId)?.markAsRead();
  }, [channelId, channels]);

  return <h2>Room ({unread} unread)</h2>;
}
```

## Guarding against double-invoked effects

`useChannel`/`useInbox` connections are refcounted in core, with a short grace period
after the last `release()` — so React StrictMode's development-only double
mount/unmount/mount doesn't cause a visible reconnect. You don't need to add your own
guards around the hooks for this.
