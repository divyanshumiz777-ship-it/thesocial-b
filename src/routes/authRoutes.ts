import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import {
  registerUser,
  providerLogin,
  loginUser,
  linkProvider,
} from "../controllers/authController.ts";

import {
  registerSchema,
  loginSchema,
  providerLoginSchema,
  linkProviderSchema,
} from "../lib/validators.ts";

import { authMiddleware } from "../middleware/authMiddleware.ts";

export const authRouter = new Hono();

authRouter.post("/register", zValidator("form", registerSchema), registerUser);

authRouter.post(
  "/provider-login",
  zValidator("json", providerLoginSchema),
  providerLogin
);

authRouter.post("/login", zValidator("json", loginSchema), loginUser);

authRouter.post(
  "/link-provider",
  authMiddleware,
  zValidator("json", linkProviderSchema),
  linkProvider
);
