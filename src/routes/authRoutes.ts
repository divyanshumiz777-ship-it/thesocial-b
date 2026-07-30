import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import {
  registerUser,
  providerLogin,
  loginUser,
  linkProvider,
} from "../controllers/authController.ts";
import {
  getTwoFactorStatus,
  setupTwoFactor,
  verifyTwoFactorSetup,
  disableTwoFactor,
  regenerateBackupCodes,
} from "../controllers/twoFactorController.ts";

import {
  registerSchema,
  loginSchema,
  providerLoginSchema,
  linkProviderSchema,
  twoFactorVerifySchema,
  twoFactorDisableSchema,
  twoFactorRegenerateBackupCodesSchema,
} from "../lib/validators.ts";

import { authMiddleware } from "../middleware/authMiddleware.ts";

export const authRouter = new Hono();

const handleValidationError = (result: any, c: any) => {
  if (!result.success) {
    console.error("Validation Error:", result.error);
    return c.json(
      { message: "Invalid request data", errors: result.error },
      400,
    );
  }
};

authRouter.post("/register", zValidator("form", registerSchema), registerUser);

authRouter.post(
  "/provider-login",
  zValidator("json", providerLoginSchema),
  providerLogin,
);

authRouter.post("/login", zValidator("json", loginSchema), loginUser);

authRouter.post(
  "/link-provider",
  authMiddleware,
  zValidator("json", linkProviderSchema),
  linkProvider,
);

authRouter.get("/2fa/status", authMiddleware, getTwoFactorStatus);
authRouter.post("/2fa/setup", authMiddleware, setupTwoFactor);
authRouter.post(
  "/2fa/verify-setup",
  authMiddleware,
  zValidator("json", twoFactorVerifySchema),
  verifyTwoFactorSetup,
);
authRouter.post(
  "/2fa/disable",
  authMiddleware,
  zValidator("json", twoFactorDisableSchema),
  disableTwoFactor,
);
authRouter.post(
  "/2fa/backup-codes/regenerate",
  authMiddleware,
  zValidator("json", twoFactorRegenerateBackupCodesSchema),
  regenerateBackupCodes,
);
