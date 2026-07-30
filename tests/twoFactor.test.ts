import { describe, it, expect } from "vitest";
import { generate } from "otplib";
import {
  createTwoFactorSecret,
  buildQrCodeDataUrl,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCodes,
  verifyAndConsumeBackupCode,
} from "../src/lib/twoFactor.ts";

describe("createTwoFactorSecret", () => {
  it("generates a non-empty base32 secret, different each call", () => {
    const a = createTwoFactorSecret();
    const b = createTwoFactorSecret();
    expect(a).toBeTruthy();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Z2-7]+$/); // base32 alphabet
  });
});

describe("buildQrCodeDataUrl", () => {
  it("returns an otpauth:// URI naming the issuer and the user's email, plus a PNG data URL", async () => {
    const secret = createTwoFactorSecret();
    const { otpauthUrl, qrCodeDataUrl } = await buildQrCodeDataUrl("user@example.com", secret);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/TheSocial/);
    expect(otpauthUrl).toContain(encodeURIComponent("user@example.com"));
    expect(qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

describe("verifyTotpCode", () => {
  it("accepts the real current code for a given secret", async () => {
    const secret = createTwoFactorSecret();
    const code = await generate({ secret });
    await expect(verifyTotpCode(secret, code)).resolves.toBe(true);
  });

  it("rejects a wrong code", async () => {
    const secret = createTwoFactorSecret();
    const realCode = await generate({ secret });
    // Flip a digit to guarantee a different, wrong code.
    const wrongDigit = realCode[0] === "0" ? "1" : "0";
    const wrongCode = wrongDigit + realCode.slice(1);
    await expect(verifyTotpCode(secret, wrongCode)).resolves.toBe(false);
  });

  it("rejects malformed input instead of throwing (non-digits, wrong length, empty)", async () => {
    const secret = createTwoFactorSecret();
    await expect(verifyTotpCode(secret, "abcdef")).resolves.toBe(false);
    await expect(verifyTotpCode(secret, "12345")).resolves.toBe(false);
    await expect(verifyTotpCode(secret, "")).resolves.toBe(false);
  });

  it("rejects a code generated for a DIFFERENT secret", async () => {
    const secretA = createTwoFactorSecret();
    const secretB = createTwoFactorSecret();
    const codeForB = await generate({ secret: secretB });
    await expect(verifyTotpCode(secretA, codeForB)).resolves.toBe(false);
  });
});

describe("generateBackupCodes", () => {
  it("generates 10 unique codes by default, each dash-separated", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[23-9A-HJ-NP-Z]{5}-[23-9A-HJ-NP-Z]{5}$/);
    }
  });

  it("supports a custom count", () => {
    expect(generateBackupCodes(3)).toHaveLength(3);
  });
});

describe("hashBackupCodes / verifyAndConsumeBackupCode", () => {
  it("hashes codes such that the plaintext is never stored as-is", async () => {
    const codes = generateBackupCodes(2);
    const hashed = await hashBackupCodes(codes);
    expect(hashed).toHaveLength(2);
    for (let i = 0; i < codes.length; i++) {
      expect(hashed[i]).not.toEqual(codes[i]);
    }
  });

  it("verifies a correct code and removes only that one from the returned list", async () => {
    const codes = generateBackupCodes(3);
    const hashed = await hashBackupCodes(codes);
    const remaining = await verifyAndConsumeBackupCode(hashed, codes[1]);
    expect(remaining).not.toBeNull();
    expect(remaining).toHaveLength(2);
    // The consumed code's hash should be gone; verifying it again must fail —
    // this is what makes a backup code single-use.
    const secondAttempt = await verifyAndConsumeBackupCode(remaining!, codes[1]);
    expect(secondAttempt).toBeNull();
  });

  it("is case-insensitive (backup codes are shown uppercase, easy to mistype casing)", async () => {
    const codes = generateBackupCodes(1);
    const hashed = await hashBackupCodes(codes);
    const remaining = await verifyAndConsumeBackupCode(hashed, codes[0].toLowerCase());
    expect(remaining).toEqual([]);
  });

  it("returns null for a code that was never issued", async () => {
    const hashed = await hashBackupCodes(generateBackupCodes(2));
    const result = await verifyAndConsumeBackupCode(hashed, "ZZZZZ-ZZZZZ");
    expect(result).toBeNull();
  });

  it("returns null (not a throw) against an empty list", async () => {
    await expect(verifyAndConsumeBackupCode([], "23456-23456")).resolves.toBeNull();
  });
});
