# @recall/memracer, the memracer CLI

Connect an agent session (or a whole machine) to memracer as a role-scoped
**seat**. A seat is identified by its folder plus seat token, never by a
harness session id. The CLI redeems an enrollment grant, writes the
harness-correct MCP config for that folder, and records the seat in a local
registry (`~/.memracer/seats.json`). It provisions and registers seats; it does
not supervise sessions.

## Install from source

```sh
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli run build     # esbuild bundle at cli/dist/index.js
pnpm --dir cli test          # vitest
npm install -g ./cli         # puts `memracer` on PATH
```

## Install from a release

The server's `/install.sh` route and every onboarding prompt print the install
command for the active release channel. On the `github-release` channel it
downloads the `cli-latest` release asset with `gh`; when that release does not
exist yet the command stops with a message pointing back to the source build
above. On the `npm` channel it is `npm i -g @recall/memracer`. See
[docs/cli-release.md](../docs/cli-release.md) for how releases are cut.

## Commands

| Command | What it does |
|---|---|
| `memracer enroll <token>` | Redeem an enrollment grant into a seat for the current folder. Detects the harness (Claude / Grok / Codex) and writes its scoped MCP config. This is how a teammate or agent connects. |
| `memracer login` | Log in as an operator via the browser paste-code flow: the CLI prints a URL, you approve in the browser, then paste the code back. Works over SSH and remote shells without a loopback listener. Stores an operator credential. |
| `memracer seat add <role>` | With a stored login, mint an enrollment for `--project` and provision a seat directly. Logged out, pass a dashboard `--token`. |
| `memracer seat ls` | List your own seats on `--project` (id, role, name, last used). Requires login. |
| `memracer seat revoke <seat>` | Revoke one of your own seats by key id or exact name. Requires login. |
| `memracer ps` | List the local seat registry, one block per project, annotated with server-side liveness when you are logged in. |
| `memracer run <role> -- <cmd>` | Launch a command under a seat's identity from that seat's folder (injects the token for env-based harnesses like Codex). |
| `memracer wait` | Block until the seat's role has claimable work, then exit (zero model tokens). Preferred idle path for a coder. |
| `memracer update` | Update the CLI to the latest release on the active channel. |

## Idle wait (`memracer wait`)

While a coder seat has nothing to claim, run `memracer wait` off-model from
the seat folder (it reads `.memracer.env`). It blocks with zero model tokens
on the server push stream until that role has claimable work, then exits so
the agent can call `coder_claim_task`. No work is reserved; availability is
advisory.

```sh
memracer wait                         # block until work is claimable
memracer wait --once                  # single check; exit 0 with work, 1 without
memracer wait --timeout 60            # give up after N seconds (0 = forever)
memracer wait --project id --role coder
```

`--project` and `--role` default from the seat env (`coder` if role is unset).
`--timeout` is seconds, with `0` meaning wait forever. `--once` checks once and
exits instead of waiting for a push.

## Onboarding paths

1. **Admin-generated prompt.** An admin opens Settings, then Seats, clicks
   *Generate {role} onboarding prompt*, and hands the block to a teammate or
   agent. It installs the CLI and runs `memracer enroll <token>`.
2. **Operator self-provision.** Run `memracer login` once, then
   `memracer seat add <role> --project <id>` to provision seats directly.

## Coder vs human seats

A **coder** seat lives in its own git worktree under `<repo>/.mcr/`; the
coding agent edits and branches there, never in the human's checkout. A
**human** seat shapes work through Frigg and typically sits on one long-lived
checkout of `main`. Once connected, each session receives its role contract
and tool surface at connect time (see `src/dashboard/public/role-contracts.js`).
The CLI only provisions the seat; it does not drive the loop.

The seat token is a secret. The CLI keeps it in the harness config and
registry outside the repo. Never commit it. Enrollment grants are single-use
and expire 15 minutes after they are generated.
