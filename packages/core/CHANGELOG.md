# @portalsdk/core

All notable changes to this package are documented here. This package is versioned
independently of the other `@portalsdk` packages.

## 0.2.1

### Fixed

- A thread reply whose `type` is bound to an extension's ephemeral transport (or an
  `ephemeral: true` send carrying `threadParentId`) now rejects with `NotYetSupportedError`
  instead of leaving as an ephemeral frame without its thread. Types bound to an extension's
  HTTP transport publish the reply with `threadParentId`, as before.
- A thread page that reaches a reply before the live stream does now fires `message` /
  `mention` for it once (the live copy is a silent dedup); previously the event was lost.
- A thread page still in flight across a channel teardown and reconnect is discarded instead
  of landing in the new session and clearing its in-flight request.
- A thread `on()` listener holds the thread like a `subscribe()` does: the thread is
  re-fetched after a teardown and reacquire while any listener remains.
- Inbox entry identity is encoded uniformly, so a channel id can never collide with a
  thread entry's key.

## 0.2.0



### Added

- **Threads.** `Message.threadParentId?` marks a reply with the id of the message it answers
  — which is also its thread id; the parent may itself be a reply. Replies are part of the
  channel's `messages`.
- **`send({ threadParentId })`** replies into a thread; the first reply to a message creates
  it. Nesting deeper than the platform allows rejects with a `BlockedError` whose `reason` is
  `"thread_depth_exceeded"`.
- **`channel.thread(threadId)`** — a `ThreadHandle`: a lens over the same store narrowed to
  one thread (`messages`, `send`, `loadPrevious`/`hasPrevious`/`isLoadingPrevious`, `on`,
  `subscribe`/`getSnapshot`). One socket, N threads. The first subscription fetches the
  thread's latest history page; live replies arrive through the channel. `loadPrevious` pages
  that thread alone, at the channel's `history` page size, and resolves `false` at the thread's
  first reply. Own replies echo through optimistic insert + ack, never the wire.
- **`channel.threads(query?)`** — the session's thread registry (`ThreadPage` of `ThreadNode`,
  with keyset `next()`): root threads by default, `{ parent }` for the threads directly under
  one, `{ root }` for a whole tree.
- **Inbox thread entries.** `InboxEntry` gains `threadId?`, `parentThreadId?`,
  `rootThreadId?`. Thread entries are siblings of the channel entry with their own
  `latest`/`unread`/`muted`/read position; `markAsRead()`/`mute()` act on that entry only.
  `channels.get(channelId, threadId?)` addresses one by `(id, threadId)`. The SDK selects and
  aggregates nothing across entries.

### Changed

- `InboxEntries.get` takes an optional second `threadId` argument. Without it the behavior is
  unchanged: the channel's own entry.

### Requires

- `@portalsdk/wire-protocol` ^0.4.0.

## 0.1.4


### Changed

- **`InboxStatus` is now exported.** Widened to `"idle" | "connecting" | "ready" |
  "reconnecting"` — types only, no runtime behavior change. A live `InboxHandle` still
  never reports `"idle"`; the value exists for consumers that model a handle that hasn't
  been created yet at all, e.g. `@portalsdk/react`'s SSR-inert `useInbox` (see its
  changelog). Previously this type was internal and inlined by consumers.

## 0.1.3

### Fixed

- **Channel upgrade URL** — now includes the required `/v1` path prefix
  (`/v1/channels/{id}`); connecting a channel against `0.1.2` or earlier fails the
  socket upgrade.
- **`publish`/history/`members`** — now sent to the realtime host instead of the api
  host, matching the routes those requests actually live on. `0.1.2` and earlier send
  these to the wrong host and fail.

## 0.1.0

First functional release — the framework-agnostic Portal client.

### Added

- **`Portal`** — synchronous, passive constructor; a channel registry (same handle per id,
  first-creation-wins options) and a lazy inbox singleton. No network until the first
  `acquire()`.
- **Channels** — refcounted handles (shared socket, grace-window teardown, `Symbol.dispose`),
  the seq-ordered message window with in-place retraction and gap-fill, `send()` (persistent
  with optimistic insert + ack, ephemeral with a local ack), backwards history paging,
  presence (detailed roster and aggregate), activity/typing, read state (`unread` +
  `markAsRead`), `members()`, extension-namespace send routing, and the full status machine
  including `degraded-http`.
- **Inbox** — entries, targeted items, and the global counter; two read models; filtered
  views; anonymous synthesis.
- **Errors** — the `PortalError` hierarchy; refusal → error-class mapping.
- **Anonymous mode** — `token` is optional; with none, the client mints and manages its own
  anonymous credential (one mint, reused everywhere, stable `anonId` across refreshes) and
  never surfaces a `TokenExpiredError`.
- **`setToken()`** — replace the token source at runtime (login/logout); a changed identity
  re-authenticates live channels and the inbox, an unchanged one is a no-op.
- Token lifecycle (refresh-once), reconnect with gap reconciliation, and a keepalive ping,
  over a wrapped `partysocket` that never appears in the public types.
- Built on `@portalsdk/wire-protocol` ^0.3.0.
