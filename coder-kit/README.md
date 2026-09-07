# coder-kit: drain a memracer queue from a dev machine

## Recommended: the memracer CLI

The CLI wires the MCP server and your coder seat token in one command. Install
it with the command your server prints at `/install.sh` (on the
`github-release` channel):

```sh
gh release download cli-latest -R recallnet/memracer -p '*.tgz' -O /tmp/mzr.tgz && npm i -g /tmp/mzr.tgz
```

Then open the project's Settings, then Seats, in the dashboard, click
**Generate coder onboarding prompt**, and paste the block into your agent. It
ends with:

```sh
memracer enroll <token>
```

The seat token is a secret. Never commit it. The CLI keeps it outside the repo
and enforces this. The token in the prompt is one-time and expires 15 minutes
after you generate it.

## Manual fallback

The supervisor is a reference queue-drainer: it connects with a coder token,
loops on `coder_check_work`, claims available work, and runs one Claude Code
session per task in an isolated workdir.

1. Copy the example config and fill in your server URL and coder token:

   ```sh
   cp coder-kit/config.example.json coder-kit/config.json
   ```

   The token is a Bearer secret. `config.json` holds it, so gitignore that
   file and never commit it.

2. Run the supervisor:

   ```sh
   node coder-kit/supervisor.mjs coder-kit/config.json
   ```

See `config.example.json` for every option (agent name, target repo, task
watchdog, poll intervals). `hooks/` holds the Stop-hook heartbeat and
PreCompact brief scripts the supervisor installs into each session;
`tests/coder-kit-*.test.ts` in the repo root exercise them.
