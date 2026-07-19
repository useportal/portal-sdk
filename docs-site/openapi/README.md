# openapi/

Expected home for Portal's HTTP API OpenAPI document (`openapi.yaml`), referenced by
`scalar.config.json`'s `/api-reference/spec` route.

This document is generated/owned by a separate service repo and wasn't available while
writing this docs site — see `docs/api-reference/index.md` and the PR description for
this repo's docs-site branch.

Once the real `openapi.yaml` lands here (or is published elsewhere and the
`filepath`/`url` in `scalar.config.json` is updated to point at it), Scalar renders the
interactive API reference automatically.
