# @portalsdk/react

All notable changes to this package are documented here. This package is versioned
independently of the other `@portalsdk` packages.

## 0.2.0

### Added

- **`useThread({ channelId, threadId, … })`** — one thread of a channel, as a selector over
  core's `ThreadHandle`: `messages` (this thread's replies only), `send` (replies into the
  thread), `loadPrevious` / `hasPrevious` / `isLoadingPrevious` (this thread's paging), and
  the channel's `status`. Takes `useChannel`'s params plus `threadId`; `onMessage` /
  `onMention` fire for the thread's replies only. Shares the channel's connection with every
  other hook on that channel — it holds the refcount while mounted and never owns a socket —
  and re-renders for its own thread's changes only.
- `useInbox` entries carry `threadId` / `parentThreadId` / `rootThreadId`, and
  `channels.get(channelId, threadId)` addresses a thread entry. No new hook.

### Changed

- `useChannel(...).messages` now includes replies (messages with `threadParentId`).

### Requires

- `@portalsdk/core` ^0.2.0.

## 0.1.2


### Changed

- **SSR-inert, not throwing.** `useChannel`/`useInbox` no longer throw when run outside a
  browser (`typeof window === "undefined"`) — a real condition in ordinary use, since a
  Next.js Client Component's code runs once during the server's prerender pass despite
  `"use client"`. Both hooks now render a stable idle snapshot there instead: no
  `acquire()`/no `portal.inbox()` call, no network, no effect registration. `dynamic(() =>
  import(...), { ssr: false })` is no longer required to use these hooks. Client-side
  behavior is unchanged.

### Added

- **`useChannel({ onMessage })`** — fires on every message delivered to the channel,
  persistent or ephemeral, same stable-ref pattern as `onMention`/`onError`.
- **`useChannel(...).setMetadata`** — pass-through to the channel handle's `setMetadata`, so
  replacing your own presence metadata no longer requires holding the core `ChannelHandle`
  directly alongside the hook.
- **`useInbox({ onItem })`** — fires once per inbox item arriving after mount. Never fires
  for the ready/backlog snapshot and never twice for the same item id (redelivery is
  deduped by core itself, not by the hook); stable-ref, same pattern as the channel
  callbacks.

### Requires

- `@portalsdk/core` ^0.1.4 — needed for `InboxStatus` (now exported, and widened to include
  `"idle"` for the SSR-inert `useInbox` result).

## 0.1.0

- `PortalProvider` — supplies the `Portal` client via context, with an optional `token` prop
  forwarded to `client.setToken` (login/logout); a fresh inline callback each render does not
  reconnect.
- `useChannel` — subscribes to a channel through `useSyncExternalStore`, drives the
  connection refcount from mount/unmount, and exposes the channel surface (messages, send,
  history, presence, activity, read state, status). Supports `readOn`
  (`"mount" | "visible" | "manual"`, including the visibility wiring) and `onMention` /
  `onError`.
- `useInbox` — subscribes to the inbox: `channels`, `items`, global `counter`, filtered
  `unseen`, `markAllRead`, and `status`, with an optional query.
- Client-only: the hooks fail loudly outside a browser (no SSR / RSC in v1). Ships
  `"use client"`.
