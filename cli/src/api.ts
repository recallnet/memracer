/** The memracer HTTP API client. Only the endpoints the CLI drives. */

export interface RedeemedSeat {
  key: string;
  keyId: string;
  /** The project id (same as projectId); kept for back-compat. */
  project: string;
  projectId: string;
  projectName: string;
  role: string;
  mcpUrl: string;
}

type DoFetch = typeof fetch;

/** Exchange an enrollment token for a role-scoped seat key. */
export async function redeemEnrollment(
  baseUrl: string,
  token: string,
  doFetch: DoFetch = fetch,
): Promise<RedeemedSeat> {
  const res = await doFetch(`${baseUrl}/api/enroll/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RedeemedSeat> & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `redeem failed (HTTP ${res.status})`);
  }
  return body as RedeemedSeat;
}

/** A freshly minted, single-use seat enrollment (the plaintext token + prompt). */
export interface MintedEnrollment {
  token: string;
  prompt: string;
  role: string;
}

/**
 * Mint a seat enrollment as the operator (CLI-managed tokens). Authenticates
 * with the stored operator token; the server admits it when the operator admins
 * `project`. Replaces the dashboard mint + paste for a logged-in operator.
 */
export async function mintEnrollment(
  baseUrl: string,
  operatorToken: string,
  project: string,
  role: string,
  doFetch: DoFetch = fetch,
): Promise<MintedEnrollment> {
  const res = await doFetch(`${baseUrl}/api/p/${project}/enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ role }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<MintedEnrollment> & { error?: string };
  if (!res.ok || !body.token) {
    throw new Error(body.error ?? `enrollment mint failed (HTTP ${res.status})`);
  }
  return body as MintedEnrollment;
}

/** A project seat and its recent liveness, as reported by the server. */
export interface SeatLive {
  keyId: string;
  role: string;
  name: string | null;
  lastRequest: number | null;
  live: boolean;
}

/** List a project's seats + liveness. Needs an operator Bearer token. */
export async function seatsLive(
  baseUrl: string,
  projectId: string,
  doFetch: DoFetch = fetch,
  token?: string,
): Promise<SeatLive[]> {
  const res = await doFetch(`${baseUrl}/api/p/${projectId}/seats/live`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = (await res.json().catch(() => null)) as SeatLive[] | { error?: string } | null;
  if (!res.ok) {
    const error = body && !Array.isArray(body) ? body.error : undefined;
    throw new Error(error ?? `seats/live failed (HTTP ${res.status})`);
  }
  return (Array.isArray(body) ? body : []) as SeatLive[];
}

/** A seat the operator OWNS on a project, as listed by GET api-keys. */
export interface Seat {
  id: string;
  name: string;
  type: string;
  createdAt: number | null;
  lastUsedAt: number | null;
}

/**
 * List the operator's OWN seats on a project. Authenticates with the stored
 * operator token; the server scopes the result to the token's owner, so this
 * never surfaces another user's seats.
 */
export async function listSeats(
  baseUrl: string,
  operatorToken: string,
  project: string,
  doFetch: DoFetch = fetch,
): Promise<Seat[]> {
  const res = await doFetch(`${baseUrl}/api/p/${project}/api-keys`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as { keys?: Seat[]; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `list seats failed (HTTP ${res.status})`);
  }
  return body.keys ?? [];
}

/** Revoke one of the operator's OWN seats by key id. */
export async function revokeSeat(
  baseUrl: string,
  operatorToken: string,
  project: string,
  keyId: string,
  doFetch: DoFetch = fetch,
): Promise<void> {
  const res = await doFetch(`${baseUrl}/api/p/${project}/api-keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `revoke seat failed (HTTP ${res.status})`);
  }
}

/**
 * The claimable-work count for a role on a project (Fix A — `memracer wait`).
 * Zero model tokens: the CLI polls this cheap COUNT and the model stays asleep
 * until it returns a positive depth. Accepts the operator OR a seat Bearer token.
 */
export async function queueDepth(
  baseUrl: string,
  token: string,
  project: string,
  role: string,
  doFetch: DoFetch = fetch,
): Promise<number> {
  const res = await doFetch(
    `${baseUrl}/api/p/${project}/queue-depth?role=${encodeURIComponent(role)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json().catch(() => ({}))) as { available?: number; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `queue-depth failed (HTTP ${res.status})`);
  }
  return body.available ?? 0;
}

/** The deployed origin, honoring MEMRACER_BASE_URL, without a trailing slash. */
export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMRACER_BASE_URL?.replace(/\/$/, "") ?? "https://memracer.com";
}
