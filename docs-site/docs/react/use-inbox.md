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

`useInbox(params?)` takes the same query shape as `inbox.view()` in core, plus `onItem`:

| Field | Type | Notes |
| --- | --- | --- |
| `channelId` | `string` | Scope the whole view (items + entry) to one channel. |
| `where` | `InboxWhere<D>` | Filter items by scalar fields of your item data, plus `type`, `channelId`, `read`, `muted`. |
| `onItem` | `(item: InboxItem<D>) => void` | Fires once per item arriving after mount. |

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

## Reacting to arrival with `onItem`

`items` is the accumulated, reactive list — right for rendering a panel. For a one-shot
reaction to a new item arriving (a toast, a sound, an analytics call), use `onItem` instead
of diffing `items` yourself:

```tsx
import { useInbox } from "@portalsdk/react";

function InboxToaster() {
  useInbox({
    onItem: (item) => {
      if (item.type === "ticket.assigned") showToast(item.title ?? "New assignment");
    },
  });
  return null;
}

function showToast(_message: string) {}
```

Firing semantics, inherited from [the underlying core event](/core/inbox#reacting-to-new-items):

- **Never fires for the items already present when the inbox becomes ready** — only for a
  genuinely new arrival after that. Render the initial backlog from `items` instead.
- **Never fires twice for the same item** — a redelivered item updates its data in `items`
  but doesn't re-announce itself. `item.id` is the notification's idempotency key, so this
  falls out of the same guarantee.
- **Stable-ref**: passing a fresh inline callback on every render doesn't drop a
  subsequently-arriving item and doesn't re-subscribe.

See [In-app notifications](/guides/in-app-notifications) for this pattern applied to a full
toast component with dismiss handling.
