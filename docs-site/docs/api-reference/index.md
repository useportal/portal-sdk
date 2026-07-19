# API reference

This section is wired up for Portal's HTTP API reference, generated from an OpenAPI
document — but that document isn't produced in this repository. It's owned and
published by a separate service repo, and isn't available at the time this docs site
was written.

The navigation entry for it (**API reference → HTTP API**) points at the path this site
expects the spec to land at:

```
docs-site/openapi/openapi.yaml
```

Once that file is dropped in at that path (or the `filepath`/`url` in
`scalar.config.json`'s `/api-reference/spec` route is pointed at wherever it's actually
published), Scalar renders the full interactive reference automatically — no further
navigation changes should be needed.

Until then, this page is the placeholder: the SDK docs in **Core SDK** and **React**
cover everything the client libraries expose over WebSocket and the small HTTP surface
they call directly (publish, history, members — see
[Wire protocol](/wire-protocol#http-surface)). Anything beyond that — the
account/admin-facing REST API for creating channels, managing members, or deploying
config outside of the CLI — isn't documented in this site yet, because no OpenAPI
source for it was available to build from.
