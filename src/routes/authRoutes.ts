import { Hono } from "hono";

import {
  googleSignIn,
  loginUser,
  registerUser,
} from "../controllers/authController.ts";

export const authRouter = new Hono();

authRouter.post("/register", registerUser);
authRouter.post("/google", googleSignIn);
authRouter.post("/login", loginUser);
