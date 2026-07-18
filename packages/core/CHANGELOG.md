# @portalsdk/core

All notable changes to this package are documented here. This package is versioned
independently of the other `@portalsdk` packages.

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
