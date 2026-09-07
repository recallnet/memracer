# goose

## Recommended: the memracer CLI

Install the CLI with the command your server prints at `/install.sh` (on the
`github-release` channel):

```sh
gh release download cli-latest -R recallnet/memracer -p '*.tgz' -O /tmp/mzr.tgz && npm i -g /tmp/mzr.tgz
```

Open the project's Settings, then Seats, in the dashboard, click
**Generate coder onboarding prompt**, paste the block into your agent, and run:

```sh
memracer enroll <token>
```

The seat token is a secret. The CLI keeps it outside the repo. The prompt token
is one-time and expires in 15 minutes.

## Manual fallback

Paste the Settings MCP client snippet for **goose** into the config location
named in the dashboard hint. Bearer token only; URL
`https://<your-memracer-host>/mcp`. The token is a secret; gitignore any config
file that holds the `Authorization: Bearer` header.
