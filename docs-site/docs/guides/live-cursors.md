# Guide: Live cursors (React)

Other users' cursors, rendered live over a shared surface: a coarse, "last known"
position carried in presence metadata so newly-joined viewers see something
immediately, and a stream of ephemeral sends for smooth movement in between.

## Why two channels of data

- **Presence metadata** (`setMetadata`) replaces your whole metadata bag and is
  re-announced to everyone through ordinary presence updates. It's the right place for
  a "last known position," because anyone who joins mid-session gets it for free as
  part of the room's presence snapshot — but every call re-broadcasts the *entire* bag
  to the room, and nothing in the SDK throttles it for you, so the guide below
  hand-rolls a throttle.
- **Ephemeral sends** (`send({ ephemeral: true, ... })`) are exactly what the core
  README calls out cursors for: no persistence, no `seq`, no history — a pure live
  signal. They're the right choice for firing on every `pointermove`, which presence
  metadata is not.

So: ephemeral sends carry the live movement, and a throttled `setMetadata` call keeps a
reasonably fresh fallback position in presence for anyone who wasn't already watching.

## The component

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Portal } from "@portalsdk/core";
import type { Message } from "@portalsdk/core";
import { useChannel } from "@portalsdk/react";

// Same module-scope client used across the app — see Quickstart.
const portal = new Portal({ apiKey: "pk_your_publishable_key" });

interface CursorPosition {
  x: number;
  y: number;
}

// Distinguishes cursor traffic from any other content type sharing this channel.
const CURSOR_TYPE = "cursor";
const METADATA_THROTTLE_MS = 250;

export function LiveCursors({ roomId }: { roomId: string }) {
  const [cursors, setCursors] = useState<Record<string, CursorPosition>>({});
  const lastMetadataSend = useRef(0);

  // useChannel drives acquire()/release() for this room and gives us send() + presence.
  const { send, presence } = useChannel<CursorPosition>({ channelId: roomId });

  useEffect(() => {
    // portal.channel(roomId) is a registry lookup, not a second connection — it
    // returns the same handle useChannel already acquired for this room, so this is
    // just how we reach the raw event stream useChannel doesn't expose (see below).
    const room = portal.channel<CursorPosition>(roomId);
    return room.on("message", (msg: Message<CursorPosition>) => {
      if (!msg.ephemeral || msg.type !== CURSOR_TYPE) return;
      setCursors((current) => ({ ...current, [msg.sender.id]: msg.content }));
    });
  }, [roomId]);

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const position: CursorPosition = { x: e.clientX, y: e.clientY };

    void send({ ephemeral: true, type: CURSOR_TYPE, content: position });

    const now = Date.now();
    if (now - lastMetadataSend.current > METADATA_THROTTLE_MS) {
      lastMetadataSend.current = now;
      portal.channel<CursorPosition>(roomId).setMetadata({ cursor: position });
    }
  }

  const fallback: Array<{ id: string; position: CursorPosition }> = [];
  if (presence?.kind === "detailed") {
    for (const p of presence.participants) {
      const cursor = p.metadata?.cursor;
      if (cursor) fallback.push({ id: p.id, position: cursor as CursorPosition });
    }
  }

  return (
    <div
      onPointerMove={onPointerMove}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {fallback
        .filter((c) => !(c.id in cursors))
        .map((c) => (
          <Cursor key={c.id} label={c.id} position={c.position} />
        ))}
      {Object.entries(cursors).map(([userId, position]) => (
        <Cursor key={userId} label={userId} position={position} />
      ))}
    </div>
  );
}

function Cursor({ label, position }: { label: string; position: CursorPosition }) {
  return (
    <div
      style={{ position: "absolute", left: position.x, top: position.y, pointerEvents: "none" }}
    >
      {label}
    </div>
  );
}
```

## Friction: reaching `setMetadata` and raw events from React

The component above works against the currently published `@portalsdk/react` (`0.1.1`),
but it's honest about a real gap rather than papering over it: `useChannel`'s result
(`UseChannelResult`) exposes `send`, `sendActivity`/`sendTyping`, and the accumulated
`messages`/`presence` — but not `setMetadata`, and not a raw `on(event, fn)` subscription
for reacting to each incoming message as a discrete event. Both exist on the core
`ChannelHandle` (see [Channels](/core/channels#presence) and
[Channels → Status and events](/core/channels#status-and-events)); neither is
re-exposed through the hook.

The workaround above — calling `portal.channel(roomId)` a second time to reach the same
handle `useChannel` already acquired — is safe (it's a registry lookup, not a new
connection: `portal.channel(id)` always returns the same object for the same id), but it
does mean the component needs direct access to the same `Portal` client instance passed
to `PortalProvider`. There's no exported `usePortal()`-style hook to read that back out
of context in `@portalsdk/react@0.1.1`, so the guide falls back to the same
module-scope `portal` reference used everywhere else in these docs, rather than pulling
it from the provider. If your `Portal` client isn't already reachable as a module-level
singleton, this pattern is more awkward than the snippet above suggests.
