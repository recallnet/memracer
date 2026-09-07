#!/usr/bin/env bash
# coder-kit/hooks/stop-heartbeat.sh — Stop hook: keep the coder session alive
# while it still holds a live memracer task lease.
#
# Contract (code.claude.com/docs/en/hooks.md): Claude Code pipes the Stop hook
# input JSON to stdin. `stop_hook_active: true` means the session is already
# continuing because of a stop hook — exit 0 and let the supervisor watchdog
# own runaway sessions. To block the stop, exit 0 and print top-level
# {"decision":"block","reason":"..."} on stdout.
#
# Fail-open: missing env, unreachable server, or a malformed response all
# exit 0 — a broken hook must never brick a session.
#
# JSON parsing and the JSON-RPC call happen in node (guaranteed present —
# Claude Code runs on it); jq/curl are not assumed. Stdin is left unread here
# so the node script inherits the hook input.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/stop-heartbeat.mjs"
