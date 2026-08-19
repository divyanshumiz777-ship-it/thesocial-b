import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

vi.mock("../src/models/PushSubscription.ts", () => ({
  PushSubscription: { find: vi.fn(), deleteOne: vi.fn() },
}));

import { PushSubscription } from "../src/models/PushSubscription.ts";

const USER_ID = "507f1f77bcf86cd799439001";

// Regression coverage for fcmPush.ts's rewrite away from firebase-admin (see
// message-primitives-gotchas / mobile-rn-rewrite-progress memory — installing
// firebase-admin forced npm to downgrade unrelated shared deps and broke
// server startup entirely). This exercises the hand-rolled JWT-bearer OAuth2
// flow + FCM v1 HTTP call against a throwaway RSA keypair, with global fetch
// mocked — no real network or real Firebase project involved.
let isFcmEnabled: typeof import("../src/lib/fcmPush.ts").isFcmEnabled;
let sendFcmToUser: typeof import("../src/lib/fcmPush.ts").sendFcmToUser;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = {
    project_id: "test-project",
    client_email: "test@test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  // fcmPush.ts reads this env var into a module-level const at import time —
  // must be set before the (dynamic, not static) import below.
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(serviceAccount);
  const mod = await import("../src/lib/fcmPush.ts");
  isFcmEnabled = mod.isFcmEnabled;
  sendFcmToUser = mod.sendFcmToUser;
});

// Routes by URL rather than call order — getAccessToken() caches the token
// for its ~1h lifetime, so which test happens to be first to actually hit
// the oauth2 endpoint (vs. reusing the cache) isn't something individual
// tests can rely on.
function mockFetch(opts: { tokenResponse?: { ok: boolean; json?: any }; sendResponse?: { ok: boolean; json?: any } }) {
  const fetchMock = vi.fn(async (url: string) => {
    const r =
      url === "https://oauth2.googleapis.com/token"
        ? opts.tokenResponse ?? { ok: true, json: { access_token: "fake-access-token", expires_in: 3600 } }
        : opts.sendResponse ?? { ok: true, json: {} };
    return {
      ok: r.ok,
      status: r.ok ? 200 : 400,
      json: async () => r.json ?? {},
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("isFcmEnabled", () => {
  it("is true once FIREBASE_SERVICE_ACCOUNT_JSON is set", () => {
    expect(isFcmEnabled()).toBe(true);
  });
});

function sendCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => url !== "https://oauth2.googleapis.com/token");
}

describe("sendFcmToUser", () => {
  it("does nothing when the user has no android/ios subscriptions", async () => {
    (PushSubscription.find as any).mockReturnValue({ lean: () => Promise.resolve([]) });
    const fetchMock = mockFetch({});

    await sendFcmToUser(USER_ID, { title: "t", body: "b" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the FCM v1 endpoint for each subscription with a bearer token", async () => {
    (PushSubscription.find as any).mockReturnValue({
      lean: () =>
        Promise.resolve([
          { _id: "sub1", fcmToken: "token-1" },
          { _id: "sub2", fcmToken: "token-2" },
        ]),
    });
    const fetchMock = mockFetch({});

    await sendFcmToUser(USER_ID, { title: "Hello", body: "World", actionUrl: "/x", notificationId: "n1" });

    const calls = sendCalls(fetchMock);
    expect(calls).toHaveLength(2);
    const [sendUrl, sendOpts] = calls[0];
    expect(sendUrl).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(sendOpts.headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(sendOpts.body);
    expect(body.message.token).toBe("token-1");
    expect(body.message.notification).toEqual({ title: "Hello", body: "World" });
    expect(body.message.data).toEqual({ actionUrl: "/x", notificationId: "n1" });
  });

  it("prunes the subscription when FCM reports the token as UNREGISTERED", async () => {
    (PushSubscription.find as any).mockReturnValue({
      lean: () => Promise.resolve([{ _id: "dead-sub", fcmToken: "stale-token" }]),
    });
    (PushSubscription.deleteOne as any).mockResolvedValue({});
    mockFetch({ sendResponse: { ok: false, json: { error: { status: "UNREGISTERED" } } } });

    await sendFcmToUser(USER_ID, { title: "t", body: "b" });

    expect(PushSubscription.deleteOne).toHaveBeenCalledWith({ _id: "dead-sub" });
  });

  it("does not prune the subscription on a non-UNREGISTERED failure", async () => {
    (PushSubscription.find as any).mockReturnValue({
      lean: () => Promise.resolve([{ _id: "sub1", fcmToken: "token-1" }]),
    });
    mockFetch({ sendResponse: { ok: false, json: { error: { status: "INTERNAL" } } } });

    await sendFcmToUser(USER_ID, { title: "t", body: "b" });

    expect(PushSubscription.deleteOne).not.toHaveBeenCalled();
  });
});
