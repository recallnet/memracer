# Marketing product frames

Fixed-frame product moments for the signed-out homepage Product section.

## Frame contract

| Property | Value |
|---|---|
| Size | **1440×900** (16:10) |
| Generator | `pnpm marketing:shots` |
| fullPage | **forbidden** for product frames |

Every PNG under `shots/` must match width×height exactly; the script exits non-zero otherwise.

## Final filenames

| File | Moment |
|---|---|
| `product-ops-1440x900.png` | Featured ops floor (needs-you + queue + activity) |
| `product-timeline-1440x900.png` | Timeline / agentic loop |
| `product-analytics-1440x900.png` | Team analytics |
| `mcp-human-1440x900.png` | Claude Code × human MCP |
| `mcp-coder-1440x900.png` | Claude Code × coder MCP |

Served at `/dashboard/marketing/shots/<file>` (no auth).

## Regenerate product frames

```bash
pnpm marketing:shots
```

Shot gen forces dark via `data-theme="dark"` and localStorage key **`memracer.react.theme`** (same as the React app — not `memracer-theme`).

Re-run after material dashboard UI changes or edits to `scripts/marketing-fixtures/claude-code-*.html`. Commit the PNGs so deploy does not need Playwright.
