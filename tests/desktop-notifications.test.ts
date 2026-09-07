// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopNotificationCopy,
  detectDesktopNotificationState,
  enableDesktopNotifications,
  formatPushEnableError,
  isPushServiceRegistrationFailure,
  subscriptionMatchesVapidKey,
  urlBase64ToUint8Array,
} from "../src/dashboard/web/lib/desktop-notifications.js";

const supported = { serviceWorker: true, pushManager: true };

/** 65-byte uncompressed P-256 point as URL-safe base64 (test fixture). */
const VAPID_B64 =
  "BPtestvapidpublickey0000000000000000000000000000000000000000000000000000000000000000000";

describe("desktop notification state machine", () => {
  it("never treats missing VAPID as subscribed", () => {
    expect(
      detectDesktopNotificationState(
        { configured: false, vapid_public_key: null, subscribed: false, subscription_count: 0, last_error_at: null },
        "default",
        supported,
      ),
    ).toBe("not_configured");
  });

  it("surfaces permission denied separately from unsubscribed", () => {
    expect(
      detectDesktopNotificationState(
        { configured: true, vapid_public_key: "k", subscribed: false, subscription_count: 0, last_error_at: null },
        "denied",
        supported,
      ),
    ).toBe("permission_denied");
  });

  it("reports delivery errors when subscribed but last send failed", () => {
    expect(
      detectDesktopNotificationState(
        { configured: true, vapid_public_key: "k", subscribed: true, subscription_count: 1, last_error_at: 1 },
        "granted",
        supported,
      ),
    ).toBe("delivery_error");
    expect(desktopNotificationCopy("delivery_error").label).toMatch(/error/i);
  });
});

describe("subscriptionMatchesVapidKey", () => {
  it("rejects when options.applicationServerKey is missing", () => {
    const subscription = { options: {} } as PushSubscription;
    expect(subscriptionMatchesVapidKey(subscription, urlBase64ToUint8Array(VAPID_B64))).toBe(false);
  });

  it("accepts a matching applicationServerKey", () => {
    const key = urlBase64ToUint8Array(VAPID_B64);
    const subscription = {
      options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    } as PushSubscription;
    expect(subscriptionMatchesVapidKey(subscription, key)).toBe(true);
  });

  it("rejects a mismatched applicationServerKey", () => {
    const key = urlBase64ToUint8Array(VAPID_B64);
    const other = new Uint8Array(key);
    other[1] = (other[1] + 1) % 256;
    const subscription = {
      options: { applicationServerKey: other.buffer },
    } as PushSubscription;
    expect(subscriptionMatchesVapidKey(subscription, key)).toBe(false);
  });
});

describe("enableDesktopNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installPushRuntime(opts: {
    permission?: NotificationPermission;
    existing?: PushSubscription | null;
    subscribeImpl?: () => Promise<PushSubscription>;
  }) {
    const order: string[] = [];
    const permission = opts.permission ?? "granted";
    const requestPermission = vi.fn(async () => {
      order.push("requestPermission");
      // pushmatic.subscribeToPush reads Notification.permission after await
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => permission,
      });
      return permission;
    });
    const unsubscribe = vi.fn(async () => {
      order.push("unsubscribe");
      return true;
    });
    const subscribe = vi.fn(async () => {
      order.push("subscribe");
      if (opts.subscribeImpl) return opts.subscribeImpl();
      return {
        endpoint: "https://push.example/sub",
        toJSON: () => ({
          endpoint: "https://push.example/sub",
          keys: { p256dh: "p256", auth: "auth" },
        }),
      } as PushSubscription;
    });
    const getSubscription = vi.fn(async () => {
      order.push("getSubscription");
      return opts.existing ?? null;
    });
    const update = vi.fn(async () => {
      order.push("update");
      return undefined;
    });
    const registration = {
      update,
      pushManager: { getSubscription, subscribe },
    } as unknown as ServiceWorkerRegistration;

    const register = vi.fn(async () => {
      order.push("register");
      return registration;
    });
    const ready = Promise.resolve(registration).then((value) => {
      order.push("ready");
      return value;
    });

    vi.stubGlobal("Notification", {
      requestPermission,
      get permission() {
        return "default";
      },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register, ready },
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function PushManager() {},
    });

    return { order, requestPermission, unsubscribe, subscribe, getSubscription, update, register };
  }

  it("rejects when permission is denied", async () => {
    installPushRuntime({ permission: "denied" });
    await expect(enableDesktopNotifications(VAPID_B64, vi.fn(async () => undefined))).rejects.toThrow(
      /permission was denied/i,
    );
  });

  it("rejects when browser APIs are missing", async () => {
    Object.defineProperty(window, "Notification", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    await expect(enableDesktopNotifications(VAPID_B64, vi.fn(async () => undefined))).rejects.toThrow(
      /not supported/i,
    );
  });

  it("calls requestPermission before any other async push step", async () => {
    const { order, requestPermission } = installPushRuntime({});
    const serverSubscribe = vi.fn(async () => undefined);
    await enableDesktopNotifications(VAPID_B64, serverSubscribe);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(order[0]).toBe("requestPermission");
    expect(order.indexOf("requestPermission")).toBeLessThan(order.indexOf("register"));
    expect(serverSubscribe).toHaveBeenCalledWith({
      endpoint: "https://push.example/sub",
      keys: { p256dh: "p256", auth: "auth" },
    });
  });

  it("unsubscribes and resubscribes when the existing key mismatches", async () => {
    const key = urlBase64ToUint8Array(VAPID_B64);
    const other = new Uint8Array(key);
    other[2] = (other[2] + 1) % 256;
    const existingUnsub = vi.fn(async () => true);
    const existing = {
      options: { applicationServerKey: other.buffer },
      unsubscribe: existingUnsub,
      toJSON: () => ({ endpoint: "https://push.example/stale", keys: { p256dh: "old", auth: "old" } }),
    } as unknown as PushSubscription;
    const { order, subscribe } = installPushRuntime({ existing });

    await enableDesktopNotifications(VAPID_B64, vi.fn(async () => undefined));
    expect(existingUnsub).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(order.indexOf("getSubscription")).toBeLessThan(order.indexOf("subscribe"));
  });

  it("reuses a matching existing subscription without resubscribing", async () => {
    const key = urlBase64ToUint8Array(VAPID_B64);
    const existing = {
      options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
      unsubscribe: vi.fn(async () => true),
      toJSON: () => ({
        endpoint: "https://push.example/good",
        keys: { p256dh: "p256", auth: "auth" },
      }),
    } as unknown as PushSubscription;
    const { subscribe } = installPushRuntime({ existing });
    const serverSubscribe = vi.fn(async () => undefined);
    await enableDesktopNotifications(VAPID_B64, serverSubscribe);
    expect(subscribe).not.toHaveBeenCalled();
    expect(serverSubscribe).toHaveBeenCalledWith({
      endpoint: "https://push.example/good",
      keys: { p256dh: "p256", auth: "auth" },
    });
  });

  it("surfaces DOMException messages from subscribe failures", async () => {
    installPushRuntime({
      subscribeImpl: async () => {
        throw new DOMException("Registration failed - push service error", "AbortError");
      },
    });
    await expect(enableDesktopNotifications(VAPID_B64, vi.fn(async () => undefined))).rejects.toThrow(
      /Couldn't register with the push service.*AbortError.*push service error/i,
    );
  });

  it("classifies AbortError / push service failures as environmental", () => {
    const err = new DOMException("Registration failed - push service error", "AbortError");
    expect(isPushServiceRegistrationFailure(err)).toBe(true);
    expect(formatPushEnableError(err)).toMatch(/Chrome, Edge, or Firefox/i);
    expect(formatPushEnableError(err)).toMatch(/AbortError/i);
    expect(desktopNotificationCopy("push_unavailable").label).toMatch(/unavailable/i);
  });
});
