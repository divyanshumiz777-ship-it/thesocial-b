import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(3, "Name must be at least 3 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  profilePic: z.instanceof(File).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  // Present only on the second call of a 2FA login (see authController.ts's
  // loginUser) — absent/empty on a normal login or the first attempt for a
  // 2FA-enabled account.
  twoFactorCode: z.string().optional(),
});

export const twoFactorVerifySchema = z.object({
  code: z.string().min(6, "Enter the 6-digit code from your authenticator app"),
});

export const twoFactorDisableSchema = z.object({
  password: z.string(),
  code: z.string().min(6, "Enter a code to confirm"),
});

export const twoFactorRegenerateBackupCodesSchema = z.object({
  password: z.string(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

export const providerLoginSchema = z.object({
  email: z.string().email(),
  name: z.string(),
  profilePic: z.string().url().optional().nullable(),
  provider: z.string(),
  providerAccountId: z.string(),
});

export const linkProviderSchema = z.object({
  userId: z.string(),
  provider: z.string(),
  providerAccountId: z.string(),
});

export type RegisterSchema = z.infer<typeof registerSchema>;
export type LoginSchema = z.infer<typeof loginSchema>;
export type ProviderLoginSchema = z.infer<typeof providerLoginSchema>;
export type LinkProviderSchema = z.infer<typeof linkProviderSchema>;
export type TwoFactorVerifySchema = z.infer<typeof twoFactorVerifySchema>;
export type TwoFactorDisableSchema = z.infer<typeof twoFactorDisableSchema>;
export type TwoFactorRegenerateBackupCodesSchema = z.infer<
  typeof twoFactorRegenerateBackupCodesSchema
>;
export type ChangePasswordSchema = z.infer<typeof changePasswordSchema>;
