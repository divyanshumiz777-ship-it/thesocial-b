import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import app from "./app.ts";
import { connectDB } from "./config/db.ts";
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

connectDB();

const PORT = Number(process.env.PORT) || 8001;

serve({
  fetch: app.fetch,
  port: PORT,
});
