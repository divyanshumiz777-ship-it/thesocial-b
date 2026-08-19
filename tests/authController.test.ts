import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => {
  const UserMock: any = vi.fn().mockImplementation((data: any) => ({
    ...data,
    _id: "newuser1",
    save: vi.fn().mockResolvedValue(undefined),
    toObject() {
      return { ...this };
    },
  }));
  UserMock.findOne = vi.fn();
  return { default: UserMock };
});

import jwt from "jsonwebtoken";
import argon2 from "argon2";
import User from "../src/models/User.ts";
import { loginUser, registerUser, providerLogin, linkProvider } from "../src/controllers/authController.ts";

const ME = "507f1f77bcf86cd799439011";

function fakeSelectableDoc(doc: any) {
  return { select: vi.fn().mockResolvedValue(doc) };
}

function mockContext(opts: { body?: any; userId?: string } = {}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => (opts.userId ? { id: opts.userId } : undefined),
    req: { valid: () => opts.body ?? {} },
    json: (b: any, status = 200) => {
      calls.push({ body: b, status });
      return { body: b, status };
    },
  };
  return { c, calls };
}

function decode(token: string) {
  return jwt.verify(token, process.env.JWT_SECRET as string) as { id: string; email: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("issued JWTs — a native client has no Next.js layer to mint one for it", () => {
  it("loginUser returns a token alongside user, decodable with the shared JWT_SECRET", async () => {
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

    const { c, calls } = mockContext({ body: { email: "a@example.com", password: "pw123456" } });
    await loginUser(c);

    expect(calls[0].body.user).toBeTruthy();
    expect(typeof calls[0].body.token).toBe("string");
    expect(decode(calls[0].body.token)).toEqual(
      expect.objectContaining({ id: ME, email: "a@example.com" }),
    );
  });

  it("loginUser does NOT return a token on the requiresTwoFactor challenge (login isn't complete yet)", async () => {
    const passwordHash = await argon2.hash("pw123456");
    const user = {
      _id: ME,
      email: "a@example.com",
      provider: "credentials",
      password: passwordHash,
      twoFactorEnabled: true,
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockReturnValue(fakeSelectableDoc(user));

    const { c, calls } = mockContext({ body: { email: "a@example.com", password: "pw123456" } });
    await loginUser(c);

    expect(calls[0].body.requiresTwoFactor).toBe(true);
    expect(calls[0].body.token).toBeUndefined();
  });

  it("registerUser returns a token for the newly created user", async () => {
    (User.findOne as any).mockResolvedValue(null);

    const { c, calls } = mockContext({
      body: { name: "New User", email: "new@example.com", password: "pw123456" },
    });
    await registerUser(c);

    expect(calls[0].status).toBe(201);
    expect(typeof calls[0].body.token).toBe("string");
    expect(decode(calls[0].body.token)).toEqual(
      expect.objectContaining({ email: "new@example.com" }),
    );
  });

  it("providerLogin returns a token for an existing matching-provider user", async () => {
    const existingUser = {
      _id: ME,
      email: "google@example.com",
      provider: "google",
      providerAccountId: "g-123",
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockResolvedValue(existingUser);

    const { c, calls } = mockContext({
      body: { email: "google@example.com", provider: "google", providerAccountId: "g-123" },
    });
    await providerLogin(c);

    expect(calls[0].status).toBe(200);
    expect(typeof calls[0].body.token).toBe("string");
    expect(decode(calls[0].body.token)).toEqual(
      expect.objectContaining({ id: ME, email: "google@example.com" }),
    );
  });

  it("providerLogin returns a token for a newly created provider user", async () => {
    (User.findOne as any).mockResolvedValue(null);

    const { c, calls } = mockContext({
      body: { email: "brandnew@example.com", provider: "google", providerAccountId: "g-999" },
    });
    await providerLogin(c);

    expect(calls[0].status).toBe(201);
    expect(typeof calls[0].body.token).toBe("string");
  });

  it("providerLogin does NOT return a token on the account-exists-with-password conflict", async () => {
    const existingUser = {
      _id: ME,
      email: "taken@example.com",
      provider: "credentials",
      toObject() {
        return { ...this };
      },
    };
    (User.findOne as any).mockResolvedValue(existingUser);

    const { c, calls } = mockContext({
      body: { email: "taken@example.com", provider: "google", providerAccountId: "g-1" },
    });
    await providerLogin(c);

    expect(calls[0].status).toBe(409);
    expect(calls[0].body.token).toBeUndefined();
  });

  it("linkProvider returns a token for the account being linked", async () => {
    const userToUpdate = {
      _id: ME,
      email: "link@example.com",
      provider: "credentials",
      providerAccountId: undefined as string | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      toObject() {
        return { ...this };
      },
    };
    (User.findById as any) = vi.fn().mockResolvedValue(userToUpdate);

    const { c, calls } = mockContext({
      userId: ME,
      body: { userId: ME, provider: "google", providerAccountId: "g-42" },
    });
    await linkProvider(c);

    expect(calls[0].status).toBe(200);
    expect(typeof calls[0].body.token).toBe("string");
  });
});
