# human-kit: onboard a teammate's session onto memracer

## Recommended: the memracer CLI

The CLI wires the MCP server, your seat token, and the session behavior in one
command. Install it with the command your server prints at `/install.sh` (on
the `github-release` channel):

```sh
gh release download cli-latest -R recallnet/memracer -p '*.tgz' -O /tmp/mzr.tgz && npm i -g /tmp/mzr.tgz
```

Then open the project's Settings, then Seats, in the dashboard, click
**Generate human onboarding prompt**, and paste the block into your agent. It
ends with:

```sh
memracer enroll <token>
```

The seat token is a secret. Never commit it. The CLI keeps it outside the repo
and enforces this. The token in the prompt is one-time and expires 15 minutes
after you generate it.

## Manual fallback

Four steps make any Claude Code session a memracer submission surface. Ask
the memracer admin for your server URL and member token first. The token is a
Bearer secret; gitignore any config file you paste it into so it never lands
in the repo.

## 1. Connect the server

```sh
claude mcp add --transport http memracer https://<your-memracer-host>/mcp \
  --header "Authorization: Bearer <your-member-token>"
```

## 2. Install the skill

Copy `skills/memracer-protocol/` into your skills directory, either globally
(`~/.claude/skills/`) or per repo (`.claude/skills/`):

```sh
cp -R human-kit/skills/memracer-protocol ~/.claude/skills/
```

The skill triggers when you share an idea or bug in plain language; you never
have to name a tool.

## 3. Install the SessionStart hook

Merge `settings.json` into the repo's `.claude/settings.json` (or pass it with
`claude --settings`). Set these host environment variables without committing
the token:

```sh
export MEMRACER_URL="https://<your-memracer-host>/mcp"
export MEMRACER_TOKEN="<your-human-member-token>"
export MEMRACER_HUMAN_KIT_DIR="/absolute/path/to/human-kit"
export MEMRACER_TERMINAL_NOTIFIER="/opt/homebrew/bin/terminal-notifier"
```

At SessionStart the hook calls `human_status` through stateless JSON-RPC and
injects the fresh result into the session. On macOS it also shows each new
returned `attention_alerts` episode once. Install `terminal-notifier` for a
notification that opens the item's dashboard link; the built-in `osascript`
notification is the fail-open fallback. The hook invokes only the configured
absolute `MEMRACER_TERMINAL_NOTIFIER`, a known Homebrew path, or
`/usr/bin/osascript`; notification children receive no `MEMRACER_*`
environment values. Seen episode IDs are kept locally at
`~/.cache/memracer/human-attention-seen.json` (override with
`MEMRACER_ALERT_STATE_FILE`). The server owns episode grace and cooldown; the
hook owns desktop delivery and local dedup.

The hook serializes local delivery with a lock next to the seen-id file.
Concurrent SessionStart processes therefore notify one episode once and merge
different episode IDs. A delivery failure leaves the episode unseen for retry;
locks older than 30 seconds are recovered.

The hook is pull-based and runs when a human session starts. It is
not server push, does not replace coders' `coder_check_work` loop, and does
not diagnose crashes or data loss. A notification reports either an open
human-directed question or queued work that has crossed its attention grace.
Every hook failure allows the session to continue.

## 4. Paste the CLAUDE.md snippet

Append `CLAUDE.md-snippet` to the repo's `CLAUDE.md` (or your global
`~/.claude/CLAUDE.md`). It teaches the session-start behavior (check
`human_status`, surface open questions) and backstops the skill after context
compaction.

## Verify

Start a fresh session in the repo and say something vague like "the dashboard
feels slow when tasks update". The session should search the repo, gather
file:line evidence, submit a task, and report the task id plus the mediator's
grooming verdict without you naming memracer.

Related surfaces: the server also exposes `/mcp__memracer__submit` and
`/mcp__memracer__status` slash prompts and `task://<id>` resources; the kit
and the prompts teach the same protocol. Coders install `coder-kit/` instead.
