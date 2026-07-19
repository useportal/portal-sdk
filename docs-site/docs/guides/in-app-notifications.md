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

## Client-side: list, and a deduplicated toast

`InboxItem.id` is the event's idempotency key — stable across redelivery — so a toast
hook keys its "already shown" set on it, not on array position or arrival order:

```tsx
// file: use-assignment-toasts.ts
import { useEffect, useRef, useState } from "react";
import type { Portal, InboxItem } from "@portalsdk/core";

interface AssignmentPayload {
  ticketId: string;
  title: string;
}

interface Toast {
  id: string;
  message: string;
}

export function useAssignmentToasts(portal: Portal) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    return portal.inbox().on("item", (item: InboxItem) => {
      if (item.type !== "ticket.assigned") return;
      if (seen.current.has(item.id)) return;
      seen.current.add(item.id);

      const data = item.data as AssignmentPayload;
      setToasts((current) => [
        ...current,
        { id: item.id, message: item.title ?? `Assigned: ${data.title}` },
      ]);
    });
  }, [portal]);

  function dismiss(id: string) {
    setToasts((current) => current.filter((t) => t.id !== id));
  }

  return { toasts, dismiss };
}
```

```tsx
// file: notifications-toaster.tsx
import type { Portal } from "@portalsdk/core";
import { useAssignmentToasts } from "./use-assignment-toasts";

export function NotificationsToaster({ portal }: { portal: Portal }) {
  const { toasts, dismiss } = useAssignmentToasts(portal);

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

`useAssignmentToasts` goes through `portal.inbox().on("item", …)` on the core client
directly rather than `useInbox`, because the published `useInbox` hook exposes the
accumulated `items`/`counter`/`unseen` state but no arrival *event* to hang a one-shot
toast off of — see the surface note in [useInbox](/react/use-inbox#no-onitem-callback).

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
