/**
 * Browser-side Web Push opt-in state machine for the dashboard.
 * Permission is never requested on bare page load — only after explicit Enable.
 *
 * Enable orchestration uses pushmatic *modular* APIs (requestPermission,
 * registerServiceWorker, subscribeToPush). Never call
 * `Pushmatic.initializePushNotifications` as-is: it registers the SW *before*
 * permission (Edge-friendly, Safari-breaking — loses the user-gesture token).
 *
 * Browser notes:
 * - Safari: first await on Enable must be requestPermission.
 * - Brave/bare Chromium: subscribe often AbortError until
 *   brave://settings/privacy → "Use Google services for push messaging".
 */
import Pushmatic from "pushmatic";

export type DesktopNotificationState =
  | "unsupported"
  | "not_configured"
  | "permission_denied"
  | "unsubscribed"
  | "subscribed"
  | "delivery_error"
  | "push_unavailable"
  | "busy";

export interface PushServerStatus {
  configured: boolean;
  vapid_public_key: string | null;
  subscribed: boolean;
  subscription_count: number;
  last_error_at: number | null;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferSourceToBytes(key: BufferSource): Uint8Array {
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}

/** True when the existing subscription was created with the same VAPID public key. */
export function subscriptionMatchesVapidKey(
  subscription: PushSubscription,
  vapidPublicKey: Uint8Array,
): boolean {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return false;
  const bytes = bufferSourceToBytes(existing);
  if (bytes.length !== vapidPublicKey.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== vapidPublicKey[i]) return false;
  }
  return true;
}

export function detectDesktopNotificationState(
  server: PushServerStatus | null,
  permission: NotificationPermission | "unsupported" = typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  runtime: { serviceWorker: boolean; pushManager: boolean } = {
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    pushManager: typeof window !== "undefined" && "PushManager" in window,
  },
): DesktopNotificationState {
  if (permission === "unsupported" || !runtime.serviceWorker || !runtime.pushManager) {
    return "unsupported";
  }
  if (!server?.configured || !server.vapid_public_key) return "not_configured";
  if (permission === "denied") return "permission_denied";
  if (server.last_error_at && server.subscribed) return "delivery_error";
  if (server.subscribed) return "subscribed";
  return "unsubscribed";
}

export async function registerDashboardServiceWorker(): Promise<ServiceWorkerRegistration> {
  // Prefer pushmatic modular register (same URL/scope as before).
  return Pushmatic.registerServiceWorker("/dashboard/sw.js");
}

function pushErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  // DOMException is Error-like but some runtimes do not use Error inheritance.
  if (err && typeof err === "object" && "message" in err) {
    const message = String((err as { message: unknown }).message ?? "").trim();
    if (message) return message;
  }
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

function pushErrorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name: unknown }).name ?? "");
  }
  return "";
}

/**
 * True when the browser/network cannot complete Web Push registration
 * (bare Chromium without FCM keys, firewall to fcm.googleapis.com, etc.).
 * Not a VAPID/server bug — surface as push_unavailable.
 */
export function isPushServiceRegistrationFailure(err: unknown): boolean {
  const name = pushErrorName(err);
  const message = pushErrorMessage(err, "").toLowerCase();
  if (name === "AbortError") return true;
  if (message.includes("push service error")) return true;
  if (message.includes("registration failed") && message.includes("push")) return true;
  return false;
}

const PUSH_UNAVAILABLE_GUIDANCE =
  "Couldn't register with the push service. Use Google Chrome, Edge, or Firefox (or on Brave open brave://settings/privacy and enable \"Use Google services for push messaging\"), and make sure your network isn't blocking Google's push service.";

/** Preserve DOMException name/message and rewrite environmental registration failures. */
export function formatPushEnableError(err: unknown): string {
  if (isPushServiceRegistrationFailure(err)) {
    const detail = pushErrorMessage(err, "Registration failed");
    const name = pushErrorName(err);
    return name ? `${PUSH_UNAVAILABLE_GUIDANCE} (${name}: ${detail})` : `${PUSH_UNAVAILABLE_GUIDANCE} (${detail})`;
  }
  const detail = pushErrorMessage(err, "Could not enable notifications.");
  const name = pushErrorName(err);
  if (name && name !== "Error" && !detail.startsWith(name)) {
    return `${name}: ${detail}`;
  }
  return detail;
}

export async function enableDesktopNotifications(
  vapidPublicKey: string,
  subscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) => Promise<void>,
): Promise<void> {
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || typeof PushManager === "undefined") {
    throw new Error("Desktop notifications are not supported in this browser.");
  }
  // FIRST await — Safari user-gesture. Use pushmatic modular requestPermission
  // (not initializePushNotifications, which registers SW before permission).
  try {
    await Pushmatic.requestPermission();
  } catch {
    throw new Error("Notification permission was denied. Enable it in the browser site settings, then try again.");
  }

  const vapidBytes = urlBase64ToUint8Array(vapidPublicKey);
  try {
    const registration = await Pushmatic.registerServiceWorker("/dashboard/sw.js");
    await registration.update();
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionMatchesVapidKey(subscription, vapidBytes)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await Pushmatic.subscribeToPush(registration, {
        userVisibleOnly: true,
        applicationServerKey: vapidBytes as BufferSource,
      });
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("Browser returned an incomplete push subscription.");
    }
    await subscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
  } catch (err) {
    throw new Error(formatPushEnableError(err), { cause: err });
  }
}

export async function disableDesktopNotifications(
  unsubscribe: (endpoint: string) => Promise<void>,
): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/dashboard/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch {
      /* still revoke server-side */
    }
    await unsubscribe(endpoint);
  }
}

export function desktopNotificationCopy(state: DesktopNotificationState): { label: string; help: string } {
  switch (state) {
    case "unsupported":
      return { label: "Unsupported", help: "This browser does not support Web Push notifications." };
    case "not_configured":
      return { label: "Not configured", help: "Server is missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." };
    case "permission_denied":
      return { label: "Blocked", help: "Permission denied. Allow notifications for this site in browser settings, then enable again." };
    case "unsubscribed":
      return { label: "Off", help: "Native desktop alerts when memracer needs you, even if this tab is closed." };
    case "subscribed":
      return { label: "On", help: "You will get a native notification for each new attention item on this device." };
    case "delivery_error":
      return { label: "Delivery error", help: "Last delivery failed. Disable and re-enable to refresh the subscription." };
    case "push_unavailable":
      return {
        label: "Unavailable",
        help: "Push registration failed in this browser or network. On Brave enable \"Use Google services for push messaging\" under brave://settings/privacy; otherwise use Chrome, Edge, or Firefox and allow Google's push service through any firewall.",
      };
    case "busy":
      return { label: "Working…", help: "Updating notification subscription." };
  }
}
