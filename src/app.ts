import { Hono } from "hono";
import { cors } from "hono/cors";

//routes
import { userRouter } from "./routes/authRoutes.ts";

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

app.route("/api/v1/auth", userRouter);

export default app;
