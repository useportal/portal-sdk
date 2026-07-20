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

import { useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useChannel } from "@portalsdk/react";

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

  const { send, setMetadata, presence } = useChannel<CursorPosition>({
    channelId: roomId,
    onMessage: (msg) => {
      if (!msg.ephemeral || msg.type !== CURSOR_TYPE) return;
      setCursors((current) => ({ ...current, [msg.sender.id]: msg.content }));
    },
  });

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const position: CursorPosition = { x: e.clientX, y: e.clientY };

    void send({ ephemeral: true, type: CURSOR_TYPE, content: position });

    const now = Date.now();
    if (now - lastMetadataSend.current > METADATA_THROTTLE_MS) {
      lastMetadataSend.current = now;
      setMetadata({ cursor: position });
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

Both signals go through `useChannel` directly — `onMessage` for the live ephemeral stream
and `setMetadata` for the throttled presence fallback. Neither requires reaching for the
core client yourself; see [useChannel](/react/use-channel#reacting-to-every-message-and-updating-presence-metadata)
for both on their own.
