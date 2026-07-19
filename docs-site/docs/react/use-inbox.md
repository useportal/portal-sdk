# useInbox

`useInbox` subscribes a component to the inbox. It's a thin binding over core's lazy
inbox singleton — and it deliberately reads from *two* stores: the global `InboxHandle`
(which carries the app-wide `counter` and `status`, and owns `markAllRead`) and a
filtered `InboxView` (which carries this view's `channels`, `items`, and `unseen`).
That's why `counter` is global — it ignores this call's filter — while `unseen` is
scoped to it.

```tsx
import { useInbox } from "@portalsdk/react";

function InboxBadge() {
  const { counter } = useInbox();
  return <span>{counter}</span>;
}
```

## Params

`useInbox(params?: InboxQuery<D>)` takes the same query shape as `inbox.view()` in core:

| Field | Type | Notes |
| --- | --- | --- |
| `channelId` | `string` | Scope the whole view (items + entry) to one channel. |
| `where` | `InboxWhere<D>` | Filter items by scalar fields of your item data, plus `type`, `channelId`, `read`, `muted`. |

```tsx
import { useInbox } from "@portalsdk/react";

interface AssignmentPayload {
  ticketId: string;
}

function AssignmentList() {
  const { items, unseen } = useInbox<AssignmentPayload>({
    where: { type: { eq: "ticket.assigned" } },
  });

  return (
    <div>
      <p>{unseen} unseen</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.data.ticketId}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Result

`useInbox` returns `channels`, `items`, `counter` (global), `unseen` (scoped to this
view's filter), `markAllRead` (global, zero-argument), and `status`.

```tsx
import { useInbox } from "@portalsdk/react";

function InboxPanel() {
  const { channels, items, counter, markAllRead, status } = useInbox();

  return (
    <div>
      <p>
        {status} — {counter} unread
      </p>
      <button onClick={() => markAllRead()}>Mark all read</button>
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            {c.name ?? c.id}: {c.unread}
          </li>
        ))}
      </ul>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title ?? item.type}</li>
        ))}
      </ul>
    </div>
  );
}
```

## No `onItem` callback

Unlike `useChannel`'s `onMention`/`onError`, `useInbox` doesn't expose a callback for
"a new item just arrived" — only the accumulated, reactive `items` array. If you need to
react to arrival as a one-shot event (a toast, a sound, an analytics call), reach for the
core client directly:

```tsx
import { useEffect } from "react";
import type { Portal, InboxItem } from "@portalsdk/core";

function useOnInboxItem(portal: Portal, onItem: (item: InboxItem) => void) {
  useEffect(() => {
    return portal.inbox().on("item", onItem);
  }, [portal, onItem]);
}
```

See [In-app notifications](/guides/in-app-notifications) for this pattern applied to a
toast, and [Inbox](/core/inbox#reacting-to-new-items) for the underlying core event.

> **Surface gap:** `InboxHandle.on("item", …)` exists in `@portalsdk/core`, but
> `@portalsdk/react`'s published `useInbox` (`0.1.1`) doesn't surface an equivalent
> `onItem` option. The hook above works around it by going through the core client
> directly, alongside `useInbox` for the rest of the inbox state.
