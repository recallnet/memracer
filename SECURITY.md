# Security

This is a reference prototype with no supported release series or response-time
commitment. Do not submit credentials, private task text, or customer data in a
public issue. Report vulnerabilities privately through the repository's GitHub
security advisory form when available, or the maintainer contact listed on the
Recall GitHub organization profile.

## Operating an instance

- Set a unique, random `BETTER_AUTH_SECRET` (at least 32 characters) and
  `NODE_ENV=production`. Production authentication refuses a missing or blank
  signing secret. The local development fallback is public and unsuitable for
  any shared instance. Keep signing and encryption keys in a secret manager.
- Configure `MEMRACER_PUBLIC_URL` for your HTTPS origin. Review trusted origins
  in `src/public-hosts.ts`; historical Recall domains are not your deployment.
- Use invite-only signup (`MEMRACER_INVITE_ONLY=1`) where appropriate, enable
  `MEMRACER_AUTH_RATE_LIMIT=1`, and enforce request limits at your trusted edge.
  Review forwarded-IP handling for your proxy topology.
- Treat project keys, operator keys, GitHub App access, provider keys, and coding
  agents as privileged. Scope permissions to the repositories and projects each
  needs. An operator key spans the owner's project memberships.
- Task evidence, prompts, mediator conversations, project memory, attachments,
  and agent outputs may contain private information and are sent to configured
  model providers. Review provider retention terms, access controls, and backup
  storage before using real data. Do not publish production database snapshots.
- Verify GitHub and billing webhook secrets, credential rotation, persistence,
  backups and restores, email delivery, and dependency advisories yourself.
  Hosted model evals can incur charges; use the deterministic fake driver for
  local tests.

If a signing or provider key is exposed, revoke or rotate it, invalidate affected
sessions and API credentials, and assess encrypted stored data and backups.
Changing the signing key may also affect stored provider-key encryption unless
`MEMRACER_SECRETS_KEY` was configured separately. Preserve the old encryption key
securely until data has been re-encrypted. Removing a key from Git history does
not revoke it.
