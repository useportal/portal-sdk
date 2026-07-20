# Guide: In-app notifications

A ticket-assignment notification that shows up in an inbox list and pops a toast the
moment it arrives — deduplicated by the item's idempotency key, since deliveries can
repeat.

## Server-side: turn an event into a notification

Notifications are created config-side, with a `notify` bridge on the channel your
assignment messages go through (see
[Authoring portal.config.ts → Notifications](/config-cli/portal-config#notifications)):

```ts
// file: portal.config.ts
import { defineConfig } from "@portalsdk/config";

interface AssignmentPayload {
  ticketId: string;
  title: string;
}

export default defineConfig({
  channels: {
    "tickets-*": {
      notify: (ctx) => {
        const assignedTo = ctx.message.to;
        if (!assignedTo || ctx.message.type !== "ticket.assigned") return null;

        const payload = ctx.message.content as AssignmentPayload;
        return {
          title: `You were assigned ${payload.title}`,
          data: payload,
          to: assignedTo,
        };
      },
    },
  },
});
```

Your app sends the assignment as an ordinary directed message (`to`, plus a `type` to
distinguish it from chat content); the config above turns matching sends into inbox
items for the assignee.

```ts
import type { ChannelHandle } from "@portalsdk/core";

interface AssignmentMessage {
  ticketId: string;
  title: string;
}

async function assignTicket(
  channel: ChannelHandle<AssignmentMessage>,
  userId: string,
  ticketId: string,
  title: string,
) {
  await channel.send({
    type: "ticket.assigned",
    to: userId,
    content: { ticketId, title },
  });
}
```

## Client-side: list, and a toast on arrival

`useInbox`'s `onItem` fires once per item arriving after mount — never for the backlog
already present when the inbox becomes ready, and never twice for the same item, since
`InboxItem.id` is the event's idempotency key and redelivery is deduped by that id. That
makes it safe to append straight onto a toast list with no dedup bookkeeping of your own:

```tsx
// file: use-assignment-toasts.ts
import { useState } from "react";
import { useInbox } from "@portalsdk/react";

interface AssignmentPayload {
  ticketId: string;
  title: string;
}

interface Toast {
  id: string;
  message: string;
}

export function useAssignmentToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useInbox<AssignmentPayload>({
    onItem: (item) => {
      if (item.type !== "ticket.assigned") return;
      setToasts((current) => [
        ...current,
        { id: item.id, message: item.title ?? `Assigned: ${item.data.title}` },
      ]);
    },
  });

  function dismiss(id: string) {
    setToasts((current) => current.filter((t) => t.id !== id));
  }

  return { toasts, dismiss };
}
```

```tsx
// file: notifications-toaster.tsx
import { useAssignmentToasts } from "./use-assignment-toasts";

export function NotificationsToaster() {
  const { toasts, dismiss } = useAssignmentToasts();

  return (
    <div>
      {toasts.map((t) => (
        <div key={t.id} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
```

`useAssignmentToasts` no longer needs the `Portal` client passed in at all — `useInbox`
reads it from `PortalProvider`'s context on its own, same as any other call to the hook.

## The persistent list

For the inbox panel itself (not the toast), `useInbox`'s accumulated `items` is the
right tool — no manual dedup needed there, since it's a snapshot of current state, not
a stream of arrival events:

```tsx
import { useInbox } from "@portalsdk/react";

interface AssignmentPayload {
  ticketId: string;
  title: string;
}

export function AssignmentInbox() {
  const { items, unseen, markAllRead } = useInbox<AssignmentPayload>({
    where: { type: { eq: "ticket.assigned" } },
  });

  return (
    <div>
      <button onClick={() => markAllRead()}>Clear ({unseen})</button>
      <ul>
        {items.map((item) => (
          <li key={item.id} onClick={() => item.markAsRead()}>
            {item.title} — {item.data.ticketId} {item.read ? "" : "•"}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`markAllRead()` here is the global, zero-argument call — it clears every inbox item, not
just the ones in this filtered view. Mark a single item read from the list itself with
`item.markAsRead()`, which never cascades to older items.
