# memracer

memracer is a reference prototype of a shared MCP server coordinating humans and coding agents on
software work. Humans submit intent and evidence through their own agent
sessions. Frigg, the server-side orchestrator (called the mediator in code), grooms
each submission into a prioritized queue and reviews coder plans. Coding
agents claim work and return pull requests. A dashboard shows the queue,
active agents, decisions, and a causal replay of each task.

This repository preserves an experiment in mediated work queues and durable
agent coordination. It is not a supported hosted service. The experiment does
not establish throughput gains or autonomous product judgment; operators must
review model decisions, agent permissions, and deployment configuration.
Historical domains and release channels in the source are not service promises.

Your existing MCP client is the primary interface. The `memracer` CLI
provisions and connects agent seats.

## How it works

1. A human calls `human_submit` from an MCP client.
2. Frigg investigates, deduplicates, clarifies, prioritizes, and reviews the
   coder's plan before execution.
3. Coders call `coder_check_work`, `coder_claim_task`, `coder_propose_plan`,
   and `coder_complete` to drain the queue without double-booking work.
4. The database is the source of truth. Sessions come and go.

Frigg keeps a per-project knowledge base so corrections survive across
sessions. Completion is verified against the PR's merge and check state
through a GitHub App or token.

Read [docs/architecture/architecture.md](docs/architecture/architecture.md)
for the service boundaries, then the rest of `docs/architecture/` for the
protocol, mediator, coder loop, task lifecycle, and dashboard.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | The server: MCP endpoint, auth, queue, mediator drivers, GitHub integration, dashboard API |
| `src/dashboard/web/` | React dashboard, bundled by Vite into `src/dashboard/web-dist/` |
| `src/dashboard/public/` | Static assets, role contracts, MCP snippet shapes, marketing frames |
| `src/eval/` | Mediator behavior evals (fixtures, classifiers, judges) |
| `tests/` | Server test suite (vitest); `tests/browser/` drives the dashboard with Playwright |
| `cli/` | The `memracer` CLI, a self-contained package with its own workspace |
| `coder-kit/` | Reference supervisor and hooks that drain a queue with Claude Code |
| `human-kit/` | Skill, hook, and snippet that turn a Claude Code session into a submission surface |
| `integrations/` | Per-harness MCP config notes (Codex, Goose, OpenCode, Forge, Antigravity) |
| `scripts/` | Build helpers, seeding, eval and migration entry points |
| `docs/` | Architecture, GitHub App setup, Postgres migration, CLI release |

## Requirements

- Node.js 24 or newer (the CLI package accepts 22+)
- pnpm 10 (`package.json` pins the exact version through `packageManager`)
- For `pnpm test:browser`: Playwright's chromium headless shell

## Build

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles the server with `tsc`, type-checks and bundles the
dashboard with Vite, smoke-tests the bundle, and copies the dashboard assets
into `dist/`.

The CLI builds separately:

```sh
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli run build
```

## Test

```sh
pnpm lint:dashboard-spacing          # dashboard spacing token lint
pnpm exec tsc -p tsconfig.json --noEmit   # server typecheck
pnpm test                            # builds the dashboard, then runs vitest
MEMRACER_TEST_DB=postgres pnpm test  # same suite over PGlite through the Postgres driver
pnpm --dir cli run typecheck         # CLI source and test typecheck
pnpm --dir cli test                  # CLI suite
```

Browser acceptance drives the real dashboard in chromium:

```sh
pnpm exec playwright install chromium --only-shell
pnpm test:browser
```

`.github/workflows/ci.yml` runs the same commands. The Postgres and browser
suites are skipped on pull requests that do not touch their inputs.

## Run

The server refuses to start without PR verification credentials unless the
mediator driver is `fake`. A local boot with no external services:

```sh
pnpm build:dashboard
MEMRACER_PUBLIC_URL=http://localhost:8787 MEMRACER_MEDIATOR_DRIVER=fake pnpm dev
```

The dashboard is served at `http://localhost:8787/dashboard` and sign-in at
`/signin`. `pnpm dev` runs `src/main.ts` with tsx; `pnpm start` runs the
compiled `dist/main.js`. `pnpm dev:dashboard` starts Vite for dashboard work.

Seed an org and project from the command line:

```sh
pnpm seed org "My Org"
pnpm seed project my-project "My Project" owner/repo
```

### Configuration

All settings come from environment variables. The main ones:

| Variable | Purpose |
|---|---|
| `PORT` (or `MEMRACER_PORT`) | Listen port, default `8787` |
| `MEMRACER_PUBLIC_URL` | Canonical HTTPS origin, used for OAuth issuer, GitHub callbacks, and share links |
| `MEMRACER_DB_PATH` | SQLite file, default `memracer.db` |
| `DATABASE_URL` | Use Postgres instead of SQLite (see [docs/postgres-migration.md](docs/postgres-migration.md)) |
| `BETTER_AUTH_SECRET` | Session and state signing secret; also encrypts stored provider keys unless `MEMRACER_SECRETS_KEY` is set |
| `MEMRACER_MEDIATOR_DRIVER` | `openrouter` (default) or `fake` |
| `OPENROUTER_API_KEY` | Host inference key. Orgs normally bring their own key in Org Settings; the host key is a fallback only for orgs in `MEMRACER_HOST_FALLBACK_ORGS` |
| `MEMRACER_GITHUB_TOKEN` or `MEMRACER_GITHUB_APP_ID` + `MEMRACER_GITHUB_APP_PRIVATE_KEY` | PR verification for `coder_complete` |
| `MEMRACER_GITHUB_APP_SLUG`, `MEMRACER_GITHUB_APP_CLIENT_ID`, `MEMRACER_GITHUB_APP_CLIENT_SECRET`, `MEMRACER_GITHUB_WEBHOOK_SECRET` | GitHub sign-in, repository enrollment, and webhook settlement (see [docs/github-app.md](docs/github-app.md)) |
| `RESEND_API_KEY` | Magic-link email delivery |
| `MEMRACER_EMAIL_FROM` | Sender address for magic-link mail and the Web Push subject; defaults to `memracer@<public host>` or `memracer@localhost` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional desktop Web Push; generate a pair with `npx web-push generate-vapid-keys` |
| `LITESTREAM_S3_BUCKET`, `LITESTREAM_S3_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | S3-compatible object store for task image attachments |
| `STRIPE_SECRET_KEY` | Billing; a test key is refused when `NODE_ENV=production` |
| `MEMRACER_INVITE_ONLY` | Gate self-serve signup |
| `MEMRACER_CLI_CHANNEL` | `github-release` (default) or `npm`; selects the CLI install command the server prints |
| `MEMRACER_MEDIATOR_POLICY_MODE`, `MEMRACER_MEDIATOR_CHEAP_MODEL`, `MEMRACER_MEDIATOR_CLASSIFIER_MODEL`, `MEMRACER_MEDIATOR_CHEAP_QUALIFIED`, `MEMRACER_MEDIATOR_GROOM_CLASSIFIER_ENABLED` | Model routing between the default and a cheaper model per job kind |

`railway.json` preserves the Railway build and start definition. Other hosts
need their own persistence, HTTPS, callback-origin, secret, backup, and process
configuration. See [SECURITY.md](SECURITY.md) before exposing an instance.
A local fake-driver boot does not supply email delivery; signing in requires
configuring `RESEND_API_KEY` and a sender. Real mediator and GitHub operations
require their own credentials.

## Connect over MCP

Create a project-scoped API key in the dashboard, then connect to
`https://<your-memracer-host>/mcp` with its Bearer token:

```sh
claude mcp add --transport http memracer https://<your-memracer-host>/mcp -H "Authorization: Bearer <memracer-api-key>"
```

Use a human key for `human_submit`, `human_status`, and `human_answer`. Use a
coder key for the `coder_check_work`, `coder_claim_task`,
`coder_propose_plan`, `coder_complete` loop. Each session receives its role
contract at connect time; the served text lives in
`src/dashboard/public/role-contracts.js`. [AGENTS.md](AGENTS.md) summarizes
the standing design constraints for agents editing this repo.

## CLI

The `memracer` CLI in `cli/` enrolls seats, writes harness MCP config, and
offers `memracer wait`, an off-model idle loop for coders. Build and link it
from this checkout:

```sh
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli run build
npm install -g ./cli
```

See [cli/README.md](cli/README.md) for commands and
[docs/cli-release.md](docs/cli-release.md) for the release channels the
server's `/install.sh` route advertises.

## Evals

`src/eval/` holds mediator behavior evals. `pnpm eval` runs them with the
deterministic fake driver; pass `--driver openrouter` with `OPENROUTER_API_KEY`
set for real-model runs. `.github/workflows/eval-nightly.yml` exposes the
stochastic tier through manual dispatch and skips cleanly when the key is absent.
Real-provider evals can incur charges.

## License

MIT. See [LICENSE](LICENSE) and [third-party asset notices](THIRD_PARTY_NOTICES.md).
