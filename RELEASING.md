# Releasing

Cross-package dependencies in this workspace use the `workspace:^` protocol (e.g.
`@portalsdk/core` depends on `@portalsdk/wire-protocol` via `workspace:^`). That's
correct for local development — it always links the in-repo package.

**Releases must use `pnpm publish`, never `npm publish`.**

`pnpm publish` rewrites `workspace:` ranges to real semver ranges (e.g.
`workspace:^` → `^0.3.0`) when it packs the tarball. `npm publish` does not
understand the `workspace:` protocol at all and ships the literal string through —
which produces a package that is uninstallable by anyone outside this workspace
(`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). This is exactly what happened to the
`@portalsdk/core@0.1.0`/`0.1.1` and `@portalsdk/react@0.1.0` releases.

Every publishable package has a `prepublishOnly` script
(`scripts/verify-publish-manifest.mjs`) that refuses to proceed unless it's running
under `pnpm publish` and the packed manifest is free of `workspace:` ranges, so this
mistake should now be caught automatically. Don't work around or remove that guard.

## Release steps

From the repo root, with a clean working tree on `main`:

1. Bump the `version` field in the package(s) you're releasing.
2. `pnpm build`
3. Publish leaf-first, i.e. publish a package's own dependencies before the package
   itself, so consumers can always resolve a satisfying version:
   ```
   cd packages/wire-protocol && pnpm publish
   cd packages/core && pnpm publish
   cd packages/react && pnpm publish
   ```
   (Only publish the packages that actually changed.)
4. Verify from outside the workspace: in a scratch directory, `npm init -y && npm i
   @portalsdk/core @portalsdk/react` should succeed and resolve
   `@portalsdk/wire-protocol` from the registry.
5. Bump the `docs-site/samples-check` pins in the same PR (see below) and commit the
   version bump(s).
6. Verify the registry is closed (see below) before you consider the release done.
7. Open the PR.

## Whoever publishes bumps the samples-check pins

`docs-site/samples-check/package.json` pins **exact** published versions — it exists
to typecheck the docs against what users actually install, so it deliberately does not
use the workspace copies. That makes it the first thing to break when a release is
incomplete.

The pin bump and the version bump belong in the **same PR** as the release. Don't leave
it for a follow-up: a PR that bumps package versions without bumping the pins ships a
docs-site that is silently checking an older SDK, and a PR that bumps the pins without
the publish having happened turns CI red for everyone.

Ordering matters, and it is **publish first, then merge**:

1. Bump versions, `pnpm build`, `pnpm publish` each changed package (leaf-first).
2. Bump the samples-check pins to those now-published versions.
3. Regenerate the lockfile so `npm ci` stays in sync — from
   `docs-site/samples-check`, run `npm install --package-lock-only` and commit the
   resulting `package-lock.json`. `npm ci` fails outright when the lockfile and
   `package.json` disagree, so a pin bump without this step is still a red build.
4. Merge.

If a PR must be opened before the publishes happen, say so in the description and
merge it only afterwards. `check:registry` (below) will fail until then, by design.

## Verify the registry is closed

Publishing several packages is not atomic. A publish can fail partway through the
sequence — an expired OTP, a network blip, a registry 5xx — leaving some tarballs on
the registry and others not. The packages that *did* land still declare their
dependency ranges against the versions that *didn't*, so the registry is left with
dangling references: `@portalsdk/react@0.1.4` requiring `@portalsdk/core@^0.1.5` when
no `0.1.5` was ever published.

Nothing in the workspace notices, because local development resolves those ranges
through `workspace:` links. The failure surfaces later and somewhere else, as a raw
`ETARGET — No matching version found` from the next `npm ci`.

**After any multi-package release, before ending the session**, confirm the registry
is closed over the release:

```
pnpm check:registry
```

It walks outward from the latest published version of each workspace package and from
the samples-check pins, resolving every `@portalsdk/*` dependency range transitively
against the registry, and fails naming the missing version and who references it.

Run it manually after publishing — it is the last step of a release, not just a CI
gate. It also runs in CI (`ci.yml` on every PR, and `publish-docs.yml` immediately
before samples-check installs) so this class of drift fails with a clear message.

If it reports a missing version that is also listed as local-and-unpublished, the
release was published only partially: **publish the missing package**, don't edit the
range that references it. Downgrading a range to paper over a missed publish ships a
package whose declared dependencies don't match the code it was built against.

If a broken version ever gets published anyway, deprecate it immediately:

```
npm deprecate @portalsdk/<pkg>@<version> "broken dependency ranges; use latest"
```
