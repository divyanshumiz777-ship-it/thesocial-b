import { Context } from "hono";
import argon2 from "argon2";
import User from "../models/User.ts";
import {
  TwoFactorVerifySchema,
  TwoFactorDisableSchema,
  TwoFactorRegenerateBackupCodesSchema,
} from "../lib/validators.ts";
import {
  createTwoFactorSecret,
  buildQrCodeDataUrl,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCodes,
  verifyAndConsumeBackupCode,
} from "../lib/twoFactor.ts";

export const getTwoFactorStatus = async (c: Context) => {
  const { id } = c.get("user");
  const user = await User.findById(id).select("twoFactorEnabled");
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({ enabled: !!user.twoFactorEnabled });
};

// Writes a fresh secret immediately but does NOT enable 2FA yet — enabling
// only happens once verifyTwoFactorSetup confirms the user actually saved
// it into an authenticator app. Refuses to run again while already
// enabled: swapping the secret out from under an active session (without
// the password+code check disableTwoFactor requires) would let anyone who
// briefly gets hold of a logged-in tab silently re-arm 2FA with a secret
// only they know, locking the real owner out.
export const setupTwoFactor = async (c: Context) => {
  const { id } = c.get("user");
  // No .select() override needed: email/twoFactorEnabled are both on the
  // default projection already. (Do NOT add a plain, unprefixed field name
  // to a select() call elsewhere in this file alongside a "+hiddenField" —
  // Mongoose treats that mix as a full inclusion-mode projection, silently
  // dropping every other default field. See loginUser's comment in
  // authController.ts for the live bug this caused.)
  const user = await User.findById(id);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.twoFactorEnabled) {
    return c.json(
      { error: "Two-factor authentication is already enabled. Disable it first to set up again." },
      400,
    );
  }

  const secret = createTwoFactorSecret();
  user.twoFactorSecret = secret;
  await user.save();

  const { otpauthUrl, qrCodeDataUrl } = await buildQrCodeDataUrl(user.email, secret);
  return c.json({ secret, otpauthUrl, qrCodeDataUrl });
};

export const verifyTwoFactorSetup = async (
  c: Context<any, any, { in: { json: TwoFactorVerifySchema }; out: { json: TwoFactorVerifySchema } }>,
) => {
  const { id } = c.get("user");
  const { code } = c.req.valid("json");

  // twoFactorEnabled needs no prefix (already on the default projection);
  // twoFactorSecret is select:false and must keep its own "+" with nothing
  // unprefixed alongside it (see setupTwoFactor's comment above).
  const user = await User.findById(id).select("+twoFactorSecret");
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.twoFactorEnabled) {
    return c.json({ error: "Two-factor authentication is already enabled." }, 400);
  }
  if (!user.twoFactorSecret) {
    return c.json({ error: "Start two-factor setup first." }, 400);
  }

  const valid = await verifyTotpCode(user.twoFactorSecret, code);
  if (!valid) {
    return c.json({ error: "Invalid code. Check your authenticator app and try again." }, 400);
  }

  const backupCodes = generateBackupCodes();
  user.twoFactorBackupCodes = await hashBackupCodes(backupCodes);
  user.twoFactorEnabled = true;
  await user.save();

  return c.json({ success: true, backupCodes });
};

export const disableTwoFactor = async (
  c: Context<any, any, { in: { json: TwoFactorDisableSchema }; out: { json: TwoFactorDisableSchema } }>,
) => {
  const { id } = c.get("user");
  const { password, code } = c.req.valid("json");

  // Every hidden field here keeps its own "+" (see setupTwoFactor's comment
  // above) — twoFactorEnabled needs none, it's already on the default
  // projection.
  const user = await User.findById(id).select(
    "+password +twoFactorSecret +twoFactorBackupCodes",
  );
  if (!user || !user.password) return c.json({ error: "User not found" }, 404);

  // 400, not 401 — this request's own JWT is perfectly valid (authMiddleware
  // already passed it); a wrong re-entered password/code here is a failed
  // business check, not an auth failure. apiClient.ts treats ANY 401 as "the
  // session itself is bad" and force-signs-out after 2 of them — reusing
  // 401 for this would lock a user out of their whole session just for
  // mistyping their password twice while trying to disable 2FA.
  const passwordOk = await argon2.verify(user.password, password);
  if (!passwordOk) return c.json({ error: "Incorrect password." }, 400);

  if (!user.twoFactorEnabled) {
    return c.json({ error: "Two-factor authentication is not enabled." }, 400);
  }

  const totpOk = user.twoFactorSecret ? await verifyTotpCode(user.twoFactorSecret, code) : false;
  const backupOk = totpOk
    ? true
    : (await verifyAndConsumeBackupCode(user.twoFactorBackupCodes ?? [], code)) !== null;

  if (!totpOk && !backupOk) {
    return c.json({ error: "Invalid code." }, 400);
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorBackupCodes = undefined;
  await user.save();

  return c.json({ success: true });
};

export const regenerateBackupCodes = async (
  c: Context<
    any,
    any,
    { in: { json: TwoFactorRegenerateBackupCodesSchema }; out: { json: TwoFactorRegenerateBackupCodesSchema } }
  >,
) => {
  const { id } = c.get("user");
  const { password } = c.req.valid("json");

  // twoFactorEnabled needs no prefix — already on the default projection.
  const user = await User.findById(id).select("+password");
  if (!user || !user.password) return c.json({ error: "User not found" }, 404);

  // See the matching comment in disableTwoFactor above re: 400 vs 401.
  const passwordOk = await argon2.verify(user.password, password);
  if (!passwordOk) return c.json({ error: "Incorrect password." }, 400);

  if (!user.twoFactorEnabled) {
    return c.json({ error: "Two-factor authentication is not enabled." }, 400);
  }

  const backupCodes = generateBackupCodes();
  user.twoFactorBackupCodes = await hashBackupCodes(backupCodes);
  await user.save();

  return c.json({ backupCodes });
};
