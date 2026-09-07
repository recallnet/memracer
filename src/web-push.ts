/**
 * Best-effort Web Push delivery for human-attention episodes.
 *
 * Never throws into task/question/mediator paths. Subscription ownership is
 * session-bound (user_id). Delivery is deduped per (endpoint, episode_id).
 */
import type { Db } from "./db.js";
import { senderAddress } from "./email.js";
import type { HumanAttentionItem } from "./human-attention.js";

export interface PushSubscriptionRecord {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  updated_at: number;
  last_success_at: number | null;
  last_error_at: number | null;
  revoked_at: number | null;
}

export interface WebPushPayload {
  title: string;
  body: string;
  url: string | null;
  episode_id: string;
  project: string;
  tag: string;
}

export type WebPushTransport = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<{ statusCode: number }>;

let testTransport: WebPushTransport | null = null;

/** Install an in-memory sender for deterministic tests; never call in production. */
export function setWebPushTransportForTests(transport: WebPushTransport | null): void {
  testTransport = transport;
}

export function vapidConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

function vapidSubject(): string {
  return process.env.VAPID_SUBJECT?.trim() || `mailto:${senderAddress()}`;
}

export function attentionToPushPayload(item: HumanAttentionItem): WebPushPayload {
  return {
    title: item.title,
    body: item.reason,
    url: item.dashboard_url,
    episode_id: item.episode_id,
    project: item.project,
    tag: item.episode_id,
  };
}

export async function upsertPushSubscription(
  db: Db,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? Date.now();
  const existing = await db
    .prepare("SELECT endpoint FROM push_subscriptions WHERE endpoint = ?")
    .get<{ endpoint: string }>(input.endpoint);
  if (existing) {
    await db
      .prepare(
        `UPDATE push_subscriptions
         SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?,
             updated_at = ?, revoked_at = NULL, last_error_at = NULL
         WHERE endpoint = ?`,
      )
      .run(
        input.userId,
        input.p256dh,
        input.auth,
        input.userAgent ?? null,
        now,
        input.endpoint,
      );
    return;
  }
  await db
    .prepare(
      `INSERT INTO push_subscriptions
         (endpoint, user_id, p256dh, auth, user_agent, created_at, updated_at,
          last_success_at, last_error_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      input.endpoint,
      input.userId,
      input.p256dh,
      input.auth,
      input.userAgent ?? null,
      now,
      now,
    );
}

export async function revokePushSubscription(
  db: Db,
  userId: string,
  endpoint: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE push_subscriptions
       SET revoked_at = ?, updated_at = ?
       WHERE endpoint = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(now, now, endpoint, userId);
  return result.changes > 0;
}

export async function listActiveSubscriptions(
  db: Db,
  userId: string,
): Promise<PushSubscriptionRecord[]> {
  return db
    .prepare(
      `SELECT endpoint, user_id, p256dh, auth, user_agent, created_at, updated_at,
              last_success_at, last_error_at, revoked_at
       FROM push_subscriptions
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .all<PushSubscriptionRecord>(userId);
}

export async function pushStatusForUser(
  db: Db,
  userId: string,
): Promise<{
  configured: boolean;
  vapid_public_key: string | null;
  subscribed: boolean;
  subscription_count: number;
  last_error_at: number | null;
}> {
  const subs = await listActiveSubscriptions(db, userId);
  const lastError = await db
    .prepare(
      `SELECT last_error_at FROM push_subscriptions
       WHERE user_id = ? AND last_error_at IS NOT NULL
       ORDER BY last_error_at DESC LIMIT 1`,
    )
    .get<{ last_error_at: number }>(userId);
  return {
    configured: vapidConfigured(),
    vapid_public_key: vapidPublicKey(),
    subscribed: subs.length > 0,
    subscription_count: subs.length,
    last_error_at: lastError?.last_error_at ?? null,
  };
}

/**
 * Claim a delivery slot for (endpoint, episode_id). Returns false if already
 * delivered — the unique constraint is the durable dedup gate.
 */
export async function claimDelivery(
  db: Db,
  endpoint: string,
  episodeId: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO push_delivery_log (endpoint, episode_id, sent_at)
         VALUES (?, ?, ?)`,
      )
      .run(endpoint, episodeId, now);
    return result.changes > 0;
  } catch {
    // Unique violation or race — already claimed.
    return false;
  }
}

async function defaultTransport(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<{ statusCode: number }> {
  // Dynamic import keeps tests light when web-push is unused.
  const webpush = await import("web-push");
  webpush.setVapidDetails(
    vapidSubject(),
    process.env.VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim(),
  );
  try {
    const result = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      payload,
      { TTL: 60 * 60 },
    );
    return { statusCode: result.statusCode };
  } catch (error) {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    return { statusCode };
  }
}

/**
 * Fan out one attention item to every active subscription for the user.
 * Fire-and-forget safe: swallows all errors.
 */
export async function notifyUserAttention(
  db: Db,
  userId: string,
  item: HumanAttentionItem,
  now: number = Date.now(),
): Promise<{ attempted: number; sent: number; skipped: number }> {
  if (!item.pushable) return { attempted: 0, sent: 0, skipped: 0 };
  if (!vapidConfigured() && !testTransport) return { attempted: 0, sent: 0, skipped: 0 };

  const subs = await listActiveSubscriptions(db, userId);
  let sent = 0;
  let skipped = 0;
  const payload = JSON.stringify(attentionToPushPayload(item));
  const transport = testTransport ?? defaultTransport;

  for (const sub of subs) {
    const claimed = await claimDelivery(db, sub.endpoint, item.episode_id, now);
    if (!claimed) {
      skipped += 1;
      continue;
    }
    try {
      const result = await transport(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      if (result.statusCode === 404 || result.statusCode === 410) {
        await db
          .prepare(
            "UPDATE push_subscriptions SET revoked_at = ?, updated_at = ?, last_error_at = ? WHERE endpoint = ?",
          )
          .run(now, now, now, sub.endpoint);
        // Keep the claim so a dead endpoint does not thrash retries.
        skipped += 1;
        continue;
      }
      if (result.statusCode >= 200 && result.statusCode < 300) {
        await db
          .prepare(
            "UPDATE push_subscriptions SET last_success_at = ?, updated_at = ? WHERE endpoint = ?",
          )
          .run(now, now, sub.endpoint);
        sent += 1;
      } else {
        // Transient failure: release the claim so a later schedule can retry.
        await db
          .prepare("DELETE FROM push_delivery_log WHERE endpoint = ? AND episode_id = ?")
          .run(sub.endpoint, item.episode_id);
        await db
          .prepare(
            "UPDATE push_subscriptions SET last_error_at = ?, updated_at = ? WHERE endpoint = ?",
          )
          .run(now, now, sub.endpoint);
        skipped += 1;
      }
    } catch {
      await db
        .prepare("DELETE FROM push_delivery_log WHERE endpoint = ? AND episode_id = ?")
        .run(sub.endpoint, item.episode_id);
      await db
        .prepare(
          "UPDATE push_subscriptions SET last_error_at = ?, updated_at = ? WHERE endpoint = ?",
        )
        .run(now, now, sub.endpoint);
      skipped += 1;
    }
  }
  return { attempted: subs.length, sent, skipped };
}

/**
 * Drop delivery-log rows older than `maxAgeMs` (default 30 days). Invoked from
 * the attention push sweep so retention is periodic, not per HTTP request.
 */
export async function prunePushDeliveryLog(
  db: Db,
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - maxAgeMs;
  const result = await db.prepare("DELETE FROM push_delivery_log WHERE sent_at < ?").run(cutoff);
  return result.changes;
}

/**
 * Notify every project human member about pushable attention items that are
 * newly present. Best-effort; never throws. Awaits fan-out via Promise.allSettled
 * so claim-log INSERTs and subscription UPDATEs finish before the caller proceeds.
 */
export async function notifyProjectHumans(
  db: Db,
  projectId: string,
  items: HumanAttentionItem[],
  now: number = Date.now(),
): Promise<void> {
  try {
    const pushable = items.filter((item) => item.pushable && item.project === projectId);
    if (pushable.length === 0) return;
    const members = await db
      .prepare(
        `SELECT m."userId" AS user_id
         FROM "member" m
         WHERE m."organizationId" = ? AND m.role IN ('human', 'admin')`,
      )
      .all<{ user_id: string }>(projectId);
    const work: Promise<unknown>[] = [];
    for (const member of members) {
      for (const item of pushable) {
        work.push(notifyUserAttention(db, member.user_id, item, now));
      }
    }
    await Promise.allSettled(work);
  } catch {
    // Never block callers.
  }
}
