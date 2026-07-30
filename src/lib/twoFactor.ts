import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import argon2 from "argon2";
import crypto from "node:crypto";

const ISSUER = "TheSocial";
const BACKUP_CODE_COUNT = 10;

export function createTwoFactorSecret(): string {
  return generateSecret();
}

export async function buildQrCodeDataUrl(
  email: string,
  secret: string,
): Promise<{ otpauthUrl: string; qrCodeDataUrl: string }> {
  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, qrCodeDataUrl };
}

// epochTolerance of 30s accepts the previous/next 30-second step in
// addition to the current one — authenticator apps and server clocks drift
// by a few seconds in practice, and without this a code entered right at a
// 30-second boundary fails unpredictably.
export async function verifyTotpCode(
  secret: string,
  token: string,
): Promise<boolean> {
  if (!token || !/^\d{6}$/.test(token.trim())) return false;
  const result = await verify({ secret, token: token.trim(), epochTolerance: 30 });
  return result.valid;
}

// 10 chars from a set that excludes visually-confusable characters (0/O,
// 1/I/L) — these are meant to be hand-copied to a password manager or
// written down, not typed live like a TOTP code.
const BACKUP_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function generateBackupCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) {
    const idx = crypto.randomInt(0, BACKUP_CODE_ALPHABET.length);
    code += BACKUP_CODE_ALPHABET[idx];
    if (i === 4) code += "-";
  }
  return code;
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateBackupCode);
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => argon2.hash(code)));
}

// Consumes (removes) the matching code on success so each backup code works
// exactly once — returns the updated hash list to persist, or null if no
// code matched.
export async function verifyAndConsumeBackupCode(
  hashedCodes: string[],
  submittedCode: string,
): Promise<string[] | null> {
  const normalized = submittedCode.trim().toUpperCase();
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await argon2.verify(hashedCodes[i], normalized)) {
      return [...hashedCodes.slice(0, i), ...hashedCodes.slice(i + 1)];
    }
  }
  return null;
}
