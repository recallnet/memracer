# MCP OAuth provider gap analysis

Pinned provider: Better Auth 1.6.23 `mcp` plugin. Protocol target: MCP
2025-11-25 authorization.

## Provider capabilities used directly

| Requirement | Better Auth route/behavior |
|---|---|
| RFC 7591 dynamic client registration | `/api/auth/mcp/register` |
| RFC 8414 authorization-server metadata | `/api/auth/.well-known/oauth-authorization-server`, with root aliases |
| RFC 9728 protected-resource metadata | `/api/auth/.well-known/oauth-protected-resource`, with root aliases |
| Authorization code and refresh grants | `/api/auth/mcp/authorize` and `/api/auth/mcp/token` |
| S256 PKCE | `requirePKCE: true`; plain challenges remain disabled |
| Interactive consent | Provider verification records and `/api/auth/oauth2/consent` |

RFC 7591 DCR is sufficient for the targeted clients, so Client ID Metadata
Documents are not required. Better Auth remains the only OAuth authorization
server and token engine.

## Verified gaps and extensions

Better Auth 1.6.23 advertises a protected resource but does not validate the
RFC 8707 `resource` parameter at either authorization or token exchange.
`src/oauth.ts` requires the exact canonical `${MEMRACER_PUBLIC_URL}/mcp` value
before delegating either operation. `/mcp` 401 responses point clients to the
matching RFC 9728 metadata URL.

Provider access-token records carry user, client, and scopes, but no memracer
Project, explicit role, seat name, or refresh-stable lease identity. The
consent extension stores those fields in `oauth_seats` and appends one opaque
`memracer_seat:<uuid>` scope to the provider's pending grant. Better Auth
copies that scope through authorization-code and refresh exchanges. Bearer
resolution accepts exactly one active seat scope, checks its user and current
Project membership, and uses the seat UUID as lease/MCP-session identity.

Do not add a parallel OAuth implementation. If a required MCP authorization
capability beyond these two gaps is absent from the pinned provider, block the
change and reassess the provider version or upstream implementation.
