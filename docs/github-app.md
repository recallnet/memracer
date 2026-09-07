# GitHub App setup

memracer uses one GitHub App for Better Auth account linking, repository-backed
Project enrollment, and (when configured) server-side PR verification.

**OAuth / install flow** uses the signed-in user's GitHub App user token to
verify the installation and list repositories. That path does not need the
App private key.

**PR verification** (`coder_complete` / `PrVerifier`) prefers a short-lived
**App installation access token** so a host without a PAT can
read merge/check state for enrolled project repos. Set:

```text
MEMRACER_GITHUB_APP_ID=<numeric app id from GitHub App settings>
MEMRACER_GITHUB_APP_PRIVATE_KEY=<PEM private key; literal \n allowed>
```

Token order: installation token for the PR's `owner/repo` (via
`github_project_repos`), then `MEMRACER_GITHUB_TOKEN`, then the host's
`gh auth token`. Without any of these, completion fails closed with a
"verification unavailable" error and the lease is kept.

## Registration

Configure the GitHub App with:

- Callback URL: `${MEMRACER_PUBLIC_URL}/api/auth/callback/github`
- Setup URL: `${MEMRACER_PUBLIC_URL}/api/github/install/callback`
- Webhook URL: `${MEMRACER_PUBLIC_URL}/api/github/webhooks`
- Webhook secret: store as `MEMRACER_GITHUB_WEBHOOK_SECRET` on the server
- Request user authorization during installation: disabled
- Redirect on update: disabled
- Account permission, Email addresses: read-only
- Repository permission, Metadata: read-only
- Repository permission, Pull requests: read-only
- Repository permission, Checks: read-only
- Subscribe to events: `pull_request`, `check_suite`, `check_run`
- Repository access during installation: All repositories or Only select repositories
- Organization permissions: none
- Repository administration permission: none

Webhook delivery is the primary path that settles `AWAITING_MERGE` tasks when a
PR merges or checks complete. The same `check_suite.completed` path files a
one-time CI-fix child task when conclusion is failure-class and the PR is
still open with failing checks. A five-minute `PrMergePoller` remains as a
backstop for missed deliveries (settle + CI-fix). HMAC verification uses
`X-Hub-Signature-256` over the raw body bytes.

The callback URL belongs to Better Auth's GitHub provider. The setup URL runs
after a new installation. With Redirect on update disabled, the authenticated
dashboard read reconciles later repository-selection changes against GitHub's
user-installations API. memracer rejects an installation unless the signed-in
user's GitHub token can list it and GitHub reports
`repository_selection=selected` or `all`. The dashboard labels which scope is
connected; Project enrollment still requires choosing one repository from the
installation's visible repository list.

## Environment

Set these values on the server process:

```text
MEMRACER_GITHUB_APP_SLUG=<public-app-slug>
MEMRACER_GITHUB_APP_CLIENT_ID=<github-app-client-id>
MEMRACER_GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
MEMRACER_GITHUB_WEBHOOK_SECRET=<github-app-webhook-secret>
# Optional but required for installation-token PR verification without a PAT:
MEMRACER_GITHUB_APP_ID=<numeric app id>
MEMRACER_GITHUB_APP_PRIVATE_KEY=<PEM private key>
# Optional PAT fallback when App install tokens are not used:
# MEMRACER_GITHUB_TOKEN=<classic or fine-grained PAT with repo/PR read>
```

Without `MEMRACER_GITHUB_WEBHOOK_SECRET` (and a PR verifier token),
`POST /api/github/webhooks` returns 503. The install/OAuth flows still work.

`BETTER_AUTH_SECRET` signs the short-lived Org/user installation state and must
already be set to the deployment's stable secret. `MEMRACER_PUBLIC_URL` must be
the canonical HTTPS origin used in both registered URLs.

Restart the server after changing these values. Verify from Team, then Projects
and Orgs: link GitHub, install the App with either all repositories or selected
repositories, choose one visible repository, and create a Project. The
resulting `projects.repo` must be the GitHub `owner/name`, and
`github_project_repos` must record its repository and installation ids.
