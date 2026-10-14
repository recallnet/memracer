# AGENTS.md

Guidance for coding agents working in this repository.

## What this repo is

memracer is a shared MCP server. Humans submit ideas and evidence through their
own agent sessions (`human_*` tools), Frigg (the hosted orchestrator, called
the mediator in code) grooms them into a prioritized queue, and coding agents
drain it (`coder_*` tools). A dashboard shows the queue, agents, and decisions.
`README.md` covers layout, build, and run. `docs/architecture/` explains the
server, protocol, mediator, coder loop, task lifecycle, and dashboard.

## Standing design constraints

- **MCP spec targeting:** build on 2025-11-25. Authenticated transport sessions
  use `initialize`, `MCP-Session-Id`, a client-opened GET stream, and durable
  `Last-Event-ID` replay. Keep headerless one-shot POSTs for off-model coder
  loops. Keep tool and task state in the DB; do not add sampling, roots, or
  logging. See `docs/architecture/mcp-protocol.md`.
- **No server-push dependence:** idle coders use the read-only
  `coder_check_work` long-poll, then explicitly call `coder_claim_task`. See
  `docs/architecture/coder-loop.md`.
- **The DB is the only source of truth.** Session ownership, capabilities,
  replay events, questions, and task state are durable; live stream handles
  are disposable process-local state. See `docs/architecture/architecture.md`.
- **Every BLOCKED task has an exit trigger.** Human or dependency blocks carry
  an open question; infrastructure blocks carry a retry clock. See
  `docs/architecture/task-lifecycle.md`.
- **Frigg approves plans; humans never gate synchronously.**
- **memracer does not model the coder's development process.** Claim to
  complete is the whole contract.
- **Model and harness swappability:** OpenRouter first; the `MediatorDriver`
  interface keeps the harness replaceable.

## Role contracts

The served role instructions live in
[`src/dashboard/public/role-contracts.js`](src/dashboard/public/role-contracts.js).
`src/tools.ts` and the dashboard onboarding snippet consume that module. Edit
the contract there; do not duplicate its text elsewhere.

- Human tools: `human_status`, `human_submit`, `human_discuss`,
  `human_followup`, `human_answer`, plus the warming and conversation tools
  listed in the contract.
- Coder tools: `coder_check_work`, `coder_claim_task`, `coder_propose_plan`,
  `coder_progress`, `coder_heartbeat`, `coder_complete`, `coder_ask`,
  `coder_report_finding`, `coder_block`, `coder_release`.

## Working in this repo

- Run `pnpm build` and `pnpm test` before you claim a change is done. CLI
  changes also need `pnpm --dir cli run typecheck`, `pnpm --dir cli run build`,
  and `pnpm --dir cli test`.
  Dashboard changes need `pnpm test:browser` (see README for the Playwright
  install step).
- Tests live next to the surface they cover: `tests/` for the server,
  `cli/tests/` for the CLI, `tests/browser/` for the dashboard.
- Open one logical change per pull request.

## Security invariants

- Production and Railway authentication must reject a missing or blank
  `BETTER_AUTH_SECRET`; the public development fallback is local-only.
- Credential files and Codex configs must be restricted to mode `0600` before
  writing bearer credentials, including when updating an existing file.
- Keep the Pi package family aligned at `0.80.6` until its changed auth/session
  APIs are migrated. Dependency updates need both `pnpm build` and the offline
  `pnpm eval` gate; compiling types alone does not catch ESM export mismatches.
