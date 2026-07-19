# Guide: Realtime chat

A complete per-room chat channel: message history, sending, presence, and membership —
built entirely on `@portalsdk/core` and `@portalsdk/react`'s published surface.

## The room component

```tsx
// file: chat-room.tsx
"use client";

import { useState, type FormEvent } from "react";
import { useChannel } from "@portalsdk/react";
import type { UseChannelResult } from "@portalsdk/react";

interface ChatMessage {
  body: string;
}

export function ChatRoom({ roomId }: { roomId: string }) {
  const [draft, setDraft] = useState("");
  const {
    messages,
    send,
    loadPrevious,
    hasPrevious,
    isLoadingPrevious,
    presence,
    typing,
    sendTyping,
    status,
  } = useChannel<ChatMessage>({ channelId: roomId, history: 30 });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (draft.trim() === "") return;
    await send({ content: { body: draft } });
    setDraft("");
  }

  return (
    <div>
      <p>status: {status}</p>

      {hasPrevious && (
        <button disabled={isLoadingPrevious} onClick={() => loadPrevious()}>
          {isLoadingPrevious ? "Loading…" : "Load older messages"}
        </button>
      )}

      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.sender.id}</strong>: {m.content.body}
          </li>
        ))}
      </ul>

      {typing.length > 0 && <p>{typing.join(", ")} typing…</p>}

      <form onSubmit={onSubmit}>
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            sendTyping();
          }}
        />
        <button type="submit">Send</button>
      </form>

      <PresenceList presence={presence} />
    </div>
  );
}

function PresenceList({ presence }: { presence: UseChannelResult<ChatMessage>["presence"] }) {
  if (presence?.kind === "detailed") {
    return (
      <ul>
        {presence.participants.map((p) => (
          <li key={p.id}>{p.username ?? p.id}</li>
        ))}
      </ul>
    );
  }

  if (presence?.kind === "aggregate") {
    return <p>{presence.count} online</p>;
  }

  return null;
}
```

Mount it wherever your router hands you a room id:

```tsx
// file: app.tsx
"use client";

import { Portal } from "@portalsdk/core";
import { PortalProvider } from "@portalsdk/react";
import { ChatRoom } from "./chat-room";

const portal = new Portal({ apiKey: "pk_your_publishable_key" });

export function App({ roomId }: { roomId: string }) {
  return (
    <PortalProvider client={portal}>
      <ChatRoom roomId={roomId} />
    </PortalProvider>
  );
}
```

## History

`history: 30` on `useChannel` backfills the last 30 messages on connect. `hasPrevious`
starts `true` and flips to `false` once `loadPrevious()` has walked back to the
beginning of the channel — the "Load older messages" button above disables itself
naturally once there's nothing left to load.

## Presence

`presence` narrows on `.kind`: small/standard rooms get a full, `"detailed"` roster
(`participants`, each with `id`, `anon`, and optional `username`/`metadata`); larger
channels degrade to `"aggregate"` (`count` plus recent join/leave deltas only, no full
list). Branch on `kind` rather than assuming one shape, as the example above does.

## Membership

Whether a user is allowed into a given room — and who's a member of it — is a
server-side concern, configured through `portal.config.ts` (`anonymous`, `authz`; see
[Authoring portal.config.ts](/config-cli/portal-config)). The client SDK doesn't expose
a "join" or "add member" call; from the client, you can only:

- read the roster with `members()` (a fetched directory, not live state — merge it with
  `presence` for online/offline), and
- catch `NotMemberError` if a user without a membership row tries to connect to a
  membership-gated channel.

```ts
import { NotMemberError } from "@portalsdk/core";
import type { ChannelHandle } from "@portalsdk/core";

async function loadRoster(room: ChannelHandle) {
  try {
    return await room.members();
  } catch (err) {
    if (err instanceof NotMemberError) {
      return [];
    }
    throw err;
  }
}
```

Adding or removing members from a channel happens on your backend, outside this SDK's
surface.
