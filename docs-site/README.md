# docs-site

Portal's public documentation: Markdown pages under `docs/`, wired up through
`scalar.config.json` for [Scalar](https://scalar.com)-hosted docs.

## Structure

```
docs-site/
  scalar.config.json     # navigation + site config (Scalar Docs 2.0 format)
  docs/
    quickstart.md
    core/                 # @portalsdk/core reference
    react/                # @portalsdk/react reference
    config-cli/           # @portalsdk/config + @portalsdk/cli
    guides/                # complete, copy-pasteable walkthroughs
    api-reference/         # placeholder — see docs/api-reference/index.md
    wire-protocol.md
  openapi/                 # expected home for the HTTP API OpenAPI doc (not yet present — see PR)
  samples-check/           # compiles every code sample against the real published packages
```

## Local preview

Requires the Scalar CLI:

```bash
npx @scalar/cli project preview scalar.config.json
```

This starts a local preview server (default port `7970`) rendering the navigation and
pages exactly as configured. The **API reference → HTTP API** route will fail to
resolve locally until an OpenAPI document exists at `openapi/openapi.yaml` — see
`docs/api-reference/index.md` and the PR description for that dependency.

## Checking code samples

Every fenced ```ts```/```tsx``` block in `docs/**/*.md` is extracted and typechecked
against the real, published versions of `@portalsdk/core`, `@portalsdk/react`, and
`@portalsdk/config` (pinned in `samples-check/package.json` — not the local workspace
build):

```bash
cd samples-check
npm install
npm run check
```

A code block whose first line is `// file: <name>` is written to `<name>` inside that
markdown file's own generated directory, so sibling blocks in one doc can import each
other (used for the small multi-file examples, e.g. a component plus the app that
mounts it). Blocks without that marker must be fully standalone.
