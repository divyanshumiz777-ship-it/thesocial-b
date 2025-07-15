import { Hono } from "hono";
import { cors } from "hono/cors";
import { userRouter } from "./routes/userRoutes.ts";
import { authRouter } from "./routes/authRoutes.ts";
import { serverRouter } from "./routes/serverRoutes.ts";

//routes

const app = new Hono();

app.get("/", (c) => c.text("Hello World"));

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.route("/api/v1/auth", authRouter);
app.route("/api/v1/profile", userRouter);
app.route("/api/v1/server", serverRouter);

export default app;
