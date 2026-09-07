# memracer multi-harness integrations

Connect coding agents to a memracer server's `/mcp` endpoint with a **Bearer**
token. Seats connect through the memracer CLI: an admin generates an
onboarding prompt in Settings, then Seats, and the teammate or agent runs
`memracer enroll <token>`, which writes the MCP config for the detected
harness.

| Harness | Config location | Pack |
|---|---|---|
| Claude Code | `claude mcp add` / project MCP | [claude/](./claude/), plus human-kit and coder-kit |
| Codex | `~/.codex/config.toml` | [codex/](./codex/) |
| Antigravity | remote MCP JSON | [antigravity/](./antigravity/) |
| OpenCode | `opencode.json` mcp.servers | [opencode/](./opencode/) |
| Forge | Forge MCP HTTP config | [forge/](./forge/) |
| Goose | Goose extensions | [goose/](./goose/) |

See [COMPAT.md](./COMPAT.md) for version notes. Each pack shows the raw
`{url, headers}` shape if you prefer to configure a harness by hand instead of
running `memracer enroll`.
