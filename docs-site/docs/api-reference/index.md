# API reference

The full HTTP API reference — every route, request/response shape, and error code —
is generated from Portal's OpenAPI document and lives at
**API reference → HTTP API** in the nav.

That covers the account/admin-facing REST API: minting tokens, publishing server
messages, managing channel membership and bans, sending notifications, and deploying
config. For the client SDK surface (`@portalsdk/core`/`@portalsdk/react`) see
**Core SDK** and **React**; for the small HTTP surface the client SDK calls directly
(publish, history, members) see [Wire protocol](/wire-protocol#http-surface). The two
overlap in places — the client-callable routes appear in both the OpenAPI reference and
the wire protocol page, described from different angles (HTTP contract vs. protocol
semantics).

WebSocket endpoints (the channel and inbox sockets, and the dashboard's live-activity
socket) aren't modeled by OpenAPI — they're documented as prose on the
[Wire protocol](/wire-protocol) page instead.
