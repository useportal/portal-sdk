# Deploy & secrets

`@portalsdk/cli` is the Portal command line: two commands, deploy your configuration and
set secrets.

```bash
npm install -g @portalsdk/cli
# or run without installing:
npx @portalsdk/cli deploy
```

## Authenticate

Every command needs your project's **secret** key (`sk_...`):

```bash
export PORTAL_SECRET=sk_your_secret_key
```

## `portal deploy`

Deploys the `portal.config.ts` in the current directory (or `--config <path>`). Your
config is authored with
[`@portalsdk/config`](https://www.npmjs.com/package/@portalsdk/config) — see
[Authoring portal.config.ts](/config-cli/portal-config).

```bash
portal deploy
```

```
✓ Deployed portal.config.ts
  Version cfg_01j…
  3 channel overrides: live-events, room-*, support
  Uploaded: hooks, 1 extension
```

Deploying is atomic — if anything fails, nothing changes. Channels with active
connections keep their current configuration until they restart; new connections use
the new version right away.

Options:

- `-c, --config <path>` — path to your config file (default: `portal.config.ts`).

## `portal secrets set <name>`

Sets a secret your config reads with `env("NAME")` (see
[Authoring portal.config.ts → Secrets](/config-cli/portal-config#secrets)). The value is
sent once and never printed.

```bash
# from a flag
portal secrets set OPENAI_API_KEY --value sk-...

# or piped on stdin
echo -n "sk-..." | portal secrets set OPENAI_API_KEY

# or typed at a hidden prompt
portal secrets set OPENAI_API_KEY
```

## Environment

| Variable | Purpose |
| --- | --- |
| `PORTAL_SECRET` | Your project secret key (`sk_...`). Required. |
| `PORTAL_API_URL` | Override the API base URL (for local development). Optional. |
