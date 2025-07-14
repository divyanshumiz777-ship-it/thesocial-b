import { Hono } from "hono";

import {
  googleSignIn,
  loginUser,
  registerUser,
} from "../controllers/authController.ts";

export const userRouter = new Hono<{
  Bindings: {
    MONGO_URI: string;
    JWT_SECRET: string;
  };
}>();

userRouter.post("/register", registerUser);
userRouter.post("/google", googleSignIn);
userRouter.post("/login", loginUser);
