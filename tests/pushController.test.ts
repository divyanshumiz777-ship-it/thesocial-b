import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/PushSubscription.ts", () => ({
  PushSubscription: { findOneAndUpdate: vi.fn(), find: vi.fn() },
}));

import { PushSubscription } from "../src/models/PushSubscription.ts";
import { registerDeviceToken } from "../src/controllers/pushController.ts";
import { isFcmEnabled, sendFcmToUser } from "../src/lib/fcmPush.ts";

const USER_ID = "507f1f77bcf86cd799439001";

function mockContext(opts: { body?: any; header?: string }) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => ({ id: USER_ID }),
    req: {
      json: async () => opts.body ?? {},
      header: () => opts.header ?? "TheSocial-Android/1.0",
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerDeviceToken", () => {
  it("upserts a device-token subscription keyed on (user, fcmToken)", async () => {
    (PushSubscription.findOneAndUpdate as any).mockResolvedValue({});

    const { c, calls } = mockContext({
      body: { fcmToken: "abc-token", platform: "android" },
    });
    await registerDeviceToken(c);

    expect(calls[0].status).toBe(200);
    expect(PushSubscription.findOneAndUpdate).toHaveBeenCalledWith(
      { user: USER_ID, fcmToken: "abc-token" },
      expect.objectContaining({
        $set: expect.objectContaining({ platform: "android" }),
        $setOnInsert: { user: USER_ID, fcmToken: "abc-token" },
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it("400s when fcmToken is missing", async () => {
    const { c, calls } = mockContext({ body: { platform: "android" } });
    await registerDeviceToken(c);

    expect(calls[0].status).toBe(400);
    expect(PushSubscription.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("400s when platform is missing or invalid", async () => {
    const { c, calls } = mockContext({ body: { fcmToken: "abc-token" } });
    await registerDeviceToken(c);

    expect(calls[0].status).toBe(400);
    expect(PushSubscription.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("fcmPush — no-op until FIREBASE_SERVICE_ACCOUNT_JSON is configured", () => {
  it("isFcmEnabled() is false with no env var set", () => {
    expect(isFcmEnabled()).toBe(false);
  });

  it("sendFcmToUser never queries subscriptions when disabled", async () => {
    await sendFcmToUser(USER_ID, { title: "t", body: "b" });
    expect(PushSubscription.find).not.toHaveBeenCalled();
  });
});
