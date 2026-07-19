# Wire protocol

`@portalsdk/core` and `@portalsdk/react` cover everything most apps need. This page is
for the smaller audience building against the wire directly — implementing a client in
another language, debugging at the frame level, or just curious what's actually on the
socket underneath `useChannel`. It describes the client-observable v1 protocol: the
WebSocket frames, the small HTTP surface the SDK calls, and the rules that make a
client implementable. Platform-internal mechanics (topology, storage, process
lifecycle) aren't part of this — they're not observable from a client anyway.

`@portalsdk/wire-protocol` is the reference implementation of everything on this page:
the frame types, the pure parse/serialize functions, and the version/URL constants.
Most applications never need it directly — reach for it only if you're implementing a
Portal client or server yourself, not if you're consuming Portal through
`@portalsdk/core`.

```bash
npm install @portalsdk/wire-protocol
```

## Connection lifecycle

### Opening a channel socket

A client opens a channel by upgrading a WebSocket connection:

```
GET wss://realtime.useportal.co/v1/channels/{channelId}?v=1&token={jwt}&leaf={hint?}&meta={base64(json)?}
```

- `v` — protocol version. Required. An unknown version gets HTTP 426.
- `token` — the signed JWT identifying the user; the app's API key is resolved from it.
- `leaf` — an opaque sticky-routing hint, echoed back from a previous `ready` frame on
  reconnect.
- `meta` — initial presence metadata (standard channels only), base64-encoded JSON, capped
  at 1KB decoded — the wire-level counterpart of `ChannelOptions.metadata` in
  `@portalsdk/core`.

If the upgrade is refused, the server responds with an HTTP 4xx and a JSON body
`{ code, reason? }` (also echoed in an `x-portal-error` header):

| HTTP | `code` |
| --- | --- |
| 401 | `invalid_token`, `token_expired` |
| 403 | `invalid_api_key`, `not_member`, `banned`, `anonymous_not_allowed` |
| 404 | `unknown_channel` |
| 426 | `unsupported_version` |
| 429 | `channel_at_capacity` (body includes `retryAfter`, in seconds) |

These are the wire-level codes behind the `PortalError` subclasses documented in
[Errors](/core/errors).

### The `ready` frame

The very first frame the server sends, exactly once per connection, is `ready`. It
carries everything the client needs to initialize: the channel's info, the connecting
user's verified identity (`me`), a starting sequence number for gap detection, the
sticky-routing `leaf` to echo back on reconnect, the current presence snapshot, the
inbox-independent channel watermark, and an extension-namespace routing table
(`bindings`) that lets `send()` route extension traffic to the right transport.

Initial message history is deliberately **not** part of the `ready` snapshot — the SDK
issues a separate `GET /history` call (see below) in parallel with the upgrade whenever
`history !== "none"`.

### Keepalive and reconnect

A lightweight `{"t":"ping"}` / `{"t":"pong"}` pair keeps the connection alive roughly
every 25 seconds — entirely internal to the SDK, never something application code
touches.

On reconnect, the client repeats the same upgrade URL with `last={seq}` added: the
server replays anything missed since that sequence number where it still has it, and
`ready` always arrives first, carrying the current head — a client's own reconnect
logic doesn't need to reason about ordering beyond "process `ready`, then whatever
follows."

## Frames on the channel socket

**Server → client:**

- `batch` — the actual data frame. One or more messages, coalesced; sequence-contiguous
  within a single connection's stream.
- `retract` — `{ id, seq, reason? }`. A message was taken back; the client mutates it
  in place rather than removing it (`Message.retracted` flips to `true`; content is
  stripped).
- `presence` — mode-shaped: `{ kind: "detailed", joined, left, count }` for smaller
  rooms, or `{ kind: "aggregate", count, recent }` for larger ones. This is the wire
  source for `ChannelHandle.presence`.
- `activity` — `{ userId, kind, since }`. Absence expires client-side after roughly 5
  seconds with no refresh — the mechanism behind `typing`/`activity` clearing on their
  own.
- `direct` — a message targeted only at this connection (not fanned out).
- `reassign` — `{ leaf }`. A topology-control frame telling the client to redirect its
  sticky routing hint; purely a transport concern.
- `error` — `{ code, reason?, ref? }`. `ref` correlates the error back to a specific
  client-sent frame when relevant (see `ephemeral` below).

Every message on the wire — persistent or ephemeral — shares one envelope shape: `id`,
`seq` (`null` for ephemeral messages, which have no ordering guarantee), `type`, `kind`,
opaque `content` (≤2KB), `sender` (`{ id, anon, username? }` — `username` only on
broadcast channels), `timestamp`, optional `to`/`mentions`, and `retracted`/`ephemeral`
flags. This is exactly the shape `Message<M>` in `@portalsdk/core` is built from.

**Client → server** (persistent publishes go over HTTP, not the socket — see below):

- `ephemeral` — `{ t: "ephemeral", cl, type, content }`. `cl` is a client-chosen tag
  used to correlate a rejection (`error.ref`) back to this specific send; this is also
  the frame extension traffic rides on. This is the wire form of
  `channel.send({ ephemeral: true, ... })`.
- `activity` — `{ kind }`, throttled client-side to roughly every 3 seconds. The wire
  form of `sendActivity`/`sendTyping`.
- `watermark` — `{ seq }`. The wire form of `markAsRead()`.
- `meta` — `{ metadata }`. Replaces presence metadata wholesale — the wire form of
  `setMetadata()`. As on the SDK surface, there's no built-in throttling here; sending
  it often means broadcasting the full bag that often.
- `ping` — keepalive, SDK-internal.

The same admission gates that apply to HTTP publishes apply here; a refusal comes back
as an `error` frame, using `ref` to identify which upstream frame it refers to.

## HTTP surface

Three endpoints, all authenticated with `authorization: Bearer {jwt}`:

- **Publish** — `POST /v1/channels/{channelId}/messages` with
  `{ type?, content, kind?, to?, mentions? }`, returning `200 { id, seq, timestamp }`
  (the `SendAck` a persistent `send()` resolves with) or a `4xx { code, reason? }` (a
  `blocked_by_middleware` code carries the end-user-visible `reason` that surfaces as
  `BlockedError.reason`).
- **History** — `GET /v1/channels/{channelId}/history`, either `?before={seq}&limit=50`
  for scrolling up, or `?from={seq}&to={seq}` for filling a detected gap. Returns
  `{ msgs, hasMore }`; retracted messages come back as tombstoned envelopes.
- **Members** — `GET /v1/channels/{channelId}/members?cursor=...`, returning
  `{ members: [{ userId, online, claims }], cursor? }` — the wire source for
  `members()`.

## Ordering, dedup, and gap-fill

Persistent messages get a per-channel `seq` at the moment they're persisted, and are
contiguous within any one connection's stream; ephemeral messages carry `seq: null` and
make no ordering promise at all. Clients dedup persistent messages by high-water mark
plus a small trailing window of seen `seq` values; `direct` frames and inbox items dedup
by `id` instead.

A gap is detected whenever a delivered `seq` is greater than `(held seq) + 1`. Filling
one is layered: first, a `last={seq}` reconnect replay; failing that, a direct HTTP
range fetch (with a small 0–2s client-side jitter, to avoid a reconnect storm hammering
the history endpoint at once). A retraction that references a `seq` the client doesn't
currently hold is kept in a tombstone set and applied the moment that message does
arrive.

## The inbox socket

A separate upgrade: `GET wss://realtime.useportal.co/inbox?v=1&token={jwt}`. An
anonymous token is refused with 403 `anonymous_not_allowed` — there's no inbox for an
identity that doesn't persist across sessions, matching `portal.inbox()`'s
permanently-empty behavior for anonymous users described in [Inbox](/core/inbox).

**Server → client:** `ready` (`{ entries, items, counter }`, the inbox's own initial
snapshot), `entry` (an `InboxEntry` row upsert), `item` (a targeted item arriving —
what fires `InboxHandle`'s `"item"` event), `counter` (badge update).

**Client → server:** `read` (`{ channelId }` — advances the *inbox* position for a
channel, independent of that channel's own watermark), `item.read` (`{ id }`),
`read.all` (zero-argument, global — the wire form of `markAllRead()`), `mute`
(`{ channelId, muted }`), `ping`.

## Versioning

`?v=1` is required on both sockets; an unrecognized version is refused with 426. Within
v1, evolution is additive only — new frame types or fields that an older client simply
ignores. Anything that would break an existing client bumps the version instead.

## Reserved surfaces

A handful of surfaces are typed into the protocol but deliberately rejected in v1 — a
client that sends one gets a loud error, not a silent no-op, and named as
`NotYetSupportedError` at the `@portalsdk/core` layer:

- media/attachment frames and upload URLs
- read-receipt reflection frames
- server-pushed-down `where` filtering (client-side filtering via `channel.view()`
  works today; server-side pushdown does not)
- webhook/event-bus surfaces
- forward paging (`loadNext` — only backward paging via `loadPrevious()` exists in v1)
