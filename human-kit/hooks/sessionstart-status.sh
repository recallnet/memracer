#!/usr/bin/env bash
# SessionStart pull + desktop attention delivery. The node implementation owns
# networking, JSON, local episode dedup, and fail-open behavior.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/sessionstart-status.mjs"
