import { Context, Next } from "hono";
import { isAdminEmail } from "../lib/admin.ts";

interface JwtPayload {
  id: string;
  email?: string;
}

export const requireAdmin = async (c: Context, next: Next) => {
  const user = c.get("user") as JwtPayload | undefined;
  if (!isAdminEmail(user?.email)) {
    return c.json(
      { error: "Forbidden", message: "Admin access required." },
      403,
    );
  }
  await next();
};
