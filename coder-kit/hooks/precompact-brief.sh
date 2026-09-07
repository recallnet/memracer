#!/usr/bin/env bash
# coder-kit/hooks/precompact-brief.sh — carry the memracer task brief across
# context compaction.
#
# Contract note (code.claude.com/docs/en/hooks.md): a PreCompact hook can only
# BLOCK compaction (top-level decision:"block"); it has no documented output
# field for injecting context or custom compaction instructions
# (`custom_instructions` is an *input* echoing what the user typed into
# /compact). The documented re-injection path is a SessionStart hook with
# matcher "compact", which fires right after compaction and may return
# {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}.
# settings.json wires this script there.
#
# Reads $MEMRACER_TASK_FILE (the .memracer-task.json the supervisor writes per
# task) and re-injects task id, title, and body (which carries the acceptance
# criteria). Missing env or file → exit 0; never brick a session.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/precompact-brief.mjs"
