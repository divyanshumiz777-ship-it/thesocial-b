import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), findOne: vi.fn() },
}));

import argon2 from "argon2";
import { generate } from "otplib";
import User from "../src/models/User.ts";
import {
  getTwoFactorStatus,
  setupTwoFactor,
  verifyTwoFactorSetup,
  disableTwoFactor,
  regenerateBackupCodes,
} from "../src/controllers/twoFactorController.ts";
import { loginUser } from "../src/controllers/authController.ts";
import { createTwoFactorSecret, hashBackupCodes, generateBackupCodes } from "../src/lib/twoFactor.ts";

const ME = "507f1f77bcf86cd799439011";

function mockContext(body: any = {}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) => (key === "user" ? { id: ME } : undefined),
    req: { valid: () => body },
    json: (b: any, status = 200) => {
      calls.push({ body: b, status });
      return { body: b, status };
    },
  };
  return { c, calls };
}

function fakeSelectableDoc(doc: any) {
  // Mirrors how these controllers call it: `await User.findById(id).select(...)`
  // — .select() itself must return something the outer `await` can resolve
  // directly to the doc (no .lean(), unlike some other controllers in this repo).
  return { select: vi.fn().mockResolvedValue(doc) };
}

function baseUser(overrides: Record<string, any> = {}) {
  return {
    _id: ME,
    email: "twofactor-test@example.com",
    twoFactorEnabled: false,
    twoFactorSecret: undefined,
    twoFactorBackupCodes: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTwoFactorStatus", () => {
  it("reports disabled for a fresh user", async () => {
    (User.findById as any).mockReturnValue(fakeSelectableDoc(baseUser()));
    const { c, calls } = mockContext();
    await getTwoFactorStatus(c);
    expect(calls[0].body).toEqual({ enabled: false });
  });

  it("reports enabled once twoFactorEnabled is true", async () => {
    (User.findById as any).mockReturnValue(fakeSelectableDoc(baseUser({ twoFactorEnabled: true })));
    const { c, calls } = mockContext();
    await getTwoFactorStatus(c);
    expect(calls[0].body).toEqual({ enabled: true });
  });
});

describe("setupTwoFactor", () => {
  it("writes a fresh secret and returns a QR code + otpauth URL, without enabling yet", async () => {
    const user = baseUser();
    // setupTwoFactor needs no .select() override (email/twoFactorEnabled are
    // both on the default projection), so findById resolves directly to the
    // doc here — unlike the fakeSelectableDoc() helper used elsewhere below.
    (User.findById as any).mockResolvedValue(user);
    const { c, calls } = mockContext();
    await setupTwoFactor(c);

    expect(user.save).toHaveBeenCalledTimes(1);
    expect(user.twoFactorSecret).toBeTruthy();
    expect(user.twoFactorEnabled).toBe(false);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body.secret).toBe(user.twoFactorSecret);
    expect(calls[0].body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses to run again while already enabled (400) rather than silently swapping the secret", async () => {
    (User.findById as any).mockResolvedValue(baseUser({ twoFactorEnabled: true }));
    const { c, calls } = mockContext();
    await setupTwoFactor(c);
    expect(calls[0].status).toBe(400);
  });
});

describe("verifyTwoFactorSetup", () => {
  it("enables 2FA and returns 10 backup codes on a correct code", async () => {
    const secret = createTwoFactorSecret();
    const user = baseUser({ twoFactorSecret: secret });
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));

    const code = await generate({ secret });
    const { c, calls } = mockContext({ code });
    await verifyTwoFactorSetup(c);

    expect(user.twoFactorEnabled).toBe(true);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(calls[0].body.success).toBe(true);
    expect(calls[0].body.backupCodes).toHaveLength(10);
  });

  it("rejects a wrong code (400) and does not enable 2FA", async () => {
    const secret = createTwoFactorSecret();
    const user = baseUser({ twoFactorSecret: secret });
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));

    const { c, calls } = mockContext({ code: "000000" });
    await verifyTwoFactorSetup(c);

    expect(calls[0].status).toBe(400);
    expect(user.twoFactorEnabled).toBe(false);
    expect(user.save).not.toHaveBeenCalled();
  });

  it("rejects if setup was never started (no secret on file)", async () => {
    (User.findById as any).mockReturnValue(fakeSelectableDoc(baseUser()));
    const { c, calls } = mockContext({ code: "123456" });
    await verifyTwoFactorSetup(c);
    expect(calls[0].status).toBe(400);
  });
});

describe("disableTwoFactor", () => {
  async function enabledUser() {
    const secret = createTwoFactorSecret();
    const backupCodes = generateBackupCodes(2);
    const hashed = await hashBackupCodes(backupCodes);
    const passwordHash = await argon2.hash("correct-horse-battery-staple");
    return {
      user: baseUser({
        twoFactorEnabled: true,
        twoFactorSecret: secret,
        twoFactorBackupCodes: hashed,
        password: passwordHash,
      }),
      secret,
      backupCodes,
    };
  }

  it("rejects a wrong password with 400, not 401 (a wrong re-entered password here isn't a session/auth failure — apiClient.ts force-signs-out a user after 2 consecutive 401s, which a mistyped password during disable must not trigger)", async () => {
    const { user } = await enabledUser();
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockContext({ password: "wrong-password", code: "000000" });
    await disableTwoFactor(c);
    expect(calls[0].status).toBe(400);
    expect(user.twoFactorEnabled).toBe(true); // unchanged
  });

  it("rejects a wrong code (400) even with the correct password", async () => {
    const { user } = await enabledUser();
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockContext({ password: "correct-horse-battery-staple", code: "000000" });
    await disableTwoFactor(c);
    expect(calls[0].status).toBe(400);
    expect(user.twoFactorEnabled).toBe(true);
  });

  it("disables with the correct password + a valid TOTP code", async () => {
    const { user, secret } = await enabledUser();
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const code = await generate({ secret });
    const { c, calls } = mockContext({ password: "correct-horse-battery-staple", code });
    await disableTwoFactor(c);

    expect(calls[0].body).toEqual({ success: true });
    expect(user.twoFactorEnabled).toBe(false);
    expect(user.twoFactorSecret).toBeUndefined();
    expect(user.twoFactorBackupCodes).toBeUndefined();
  });

  it("also accepts a valid BACKUP code instead of a TOTP code", async () => {
    const { user, backupCodes } = await enabledUser();
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockContext({ password: "correct-horse-battery-staple", code: backupCodes[0] });
    await disableTwoFactor(c);

    expect(calls[0].body).toEqual({ success: true });
    expect(user.twoFactorEnabled).toBe(false);
  });
});

describe("regenerateBackupCodes", () => {
  it("rejects a wrong password with 400", async () => {
    const passwordHash = await argon2.hash("my-real-password");
    const user = baseUser({ twoFactorEnabled: true, password: passwordHash });
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockContext({ password: "nope" });
    await regenerateBackupCodes(c);
    expect(calls[0].status).toBe(400);
  });

  it("issues a fresh set of 10 codes on the correct password", async () => {
    const passwordHash = await argon2.hash("my-real-password");
    const oldHashed = await hashBackupCodes(generateBackupCodes(2));
    const user = baseUser({ twoFactorEnabled: true, password: passwordHash, twoFactorBackupCodes: oldHashed });
    (User.findById as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockContext({ password: "my-real-password" });
    await regenerateBackupCodes(c);

    expect(calls[0].body.backupCodes).toHaveLength(10);
    expect(user.twoFactorBackupCodes).not.toEqual(oldHashed);
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});

describe("loginUser — 2FA challenge", () => {
  function mockLoginContext(body: any) {
    const calls: { body: any; status: number }[] = [];
    const c: any = {
      get: () => ({ id: ME }),
      req: { valid: () => body },
      json: (b: any, status = 200) => {
        calls.push({ body: b, status });
        return { body: b, status };
      },
    };
    return { c, calls };
  }

  it("logs in normally when 2FA is not enabled", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: false,
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockLoginContext({ email: "a@example.com", password: "pw123456" });
    await loginUser(c);
    expect(calls[0].body.user).toBeTruthy();
    expect(calls[0].body.requiresTwoFactor).toBeUndefined();
  });

  it("returns requiresTwoFactor (200, not an error) when the password is right but no code was sent", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const secret = createTwoFactorSecret();
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockLoginContext({ email: "a@example.com", password: "pw123456" });
    await loginUser(c);
    expect(calls[0]).toEqual({ body: { requiresTwoFactor: true }, status: 200 });
  });

  it("rejects an invalid 2FA code with 401 and a distinguishable message (this path IS a real auth failure — unlike disable/regenerate, there's no already-established session for apiClient.ts's signout counter to wrongly act on, since loginUser is called pre-session, directly from NextAuth's route.ts, never through apiClient)", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const secret = createTwoFactorSecret();
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockLoginContext({
      email: "a@example.com",
      password: "pw123456",
      twoFactorCode: "000000",
    });
    await loginUser(c);
    expect(calls[0]).toEqual({ body: { message: "Invalid two-factor code" }, status: 401 });
  });

  it("logs in with a correct TOTP code", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const secret = createTwoFactorSecret();
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));
    const code = await generate({ secret });
    const { c, calls } = mockLoginContext({ email: "a@example.com", password: "pw123456", twoFactorCode: code });
    await loginUser(c);
    expect(calls[0].body.user).toBeTruthy();
    expect(calls[0].body.user.twoFactorSecret).toBeUndefined();
  });

  it("logs in with a correct backup code and consumes it (single-use)", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const backupCodes = generateBackupCodes(2);
    const hashed = await hashBackupCodes(backupCodes);
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: true,
      twoFactorSecret: createTwoFactorSecret(),
      twoFactorBackupCodes: hashed,
      save: vi.fn().mockResolvedValue(undefined),
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));
    const { c, calls } = mockLoginContext({
      email: "a@example.com",
      password: "pw123456",
      twoFactorCode: backupCodes[0],
    });
    await loginUser(c);

    expect(calls[0].body.user).toBeTruthy();
    expect(user.twoFactorBackupCodes).toHaveLength(1); // one consumed
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});
