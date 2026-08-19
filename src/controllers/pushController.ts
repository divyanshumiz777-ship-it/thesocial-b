import { Context } from "hono";
import { PushSubscription } from "../models/PushSubscription.ts";
import { getVapidPublicKey, isPushEnabled } from "../lib/webPush.ts";

// Public — the frontend needs this before the user is necessarily even
// signed in to decide whether to show a "enable notifications" prompt, and
// a VAPID public key is not sensitive (it's sent to every browser's push
// service on every subscribe call regardless).
export const getPushConfig = async (c: Context) => {
  return c.json({ enabled: isPushEnabled(), publicKey: getVapidPublicKey() });
};

export const subscribePush = async (c: Context) => {
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { endpoint, keys } = body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return c.json({ error: "Invalid push subscription payload" }, 400);
    }

    await PushSubscription.findOneAndUpdate(
      { user: user.id, endpoint },
      {
        $set: {
          keys: { p256dh: keys.p256dh, auth: keys.auth },
          userAgent: c.req.header("user-agent"),
        },
        $setOnInsert: { user: user.id, endpoint },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return c.json({ message: "Subscribed" }, 200);
  } catch (error) {
    console.error("Error subscribing to push:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const unsubscribePush = async (c: Context) => {
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { endpoint } = body as { endpoint?: string };
    if (!endpoint) return c.json({ error: "endpoint is required" }, 400);

    await PushSubscription.deleteOne({ user: user.id, endpoint });
    return c.json({ message: "Unsubscribed" }, 200);
  } catch (error) {
    console.error("Error unsubscribing from push:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Native counterpart to subscribePush — a Capacitor app has no browser Push
// API, so it registers an FCM device token instead of a web {endpoint, keys}
// subscription. Safe to call today even with no Firebase project configured
// yet (see fcmPush.ts's isFcmEnabled()): the token is stored either way, and
// dispatch simply no-ops until FIREBASE_SERVICE_ACCOUNT_JSON is set.
export const registerDeviceToken = async (c: Context) => {
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { fcmToken, platform } = body as {
      fcmToken?: string;
      platform?: "android" | "ios";
    };

    if (!fcmToken || (platform !== "android" && platform !== "ios")) {
      return c.json({ error: "fcmToken and a valid platform are required" }, 400);
    }

    await PushSubscription.findOneAndUpdate(
      { user: user.id, fcmToken },
      {
        $set: { platform, userAgent: c.req.header("user-agent") },
        $setOnInsert: { user: user.id, fcmToken },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return c.json({ message: "Device registered" }, 200);
  } catch (error) {
    console.error("Error registering device token:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
