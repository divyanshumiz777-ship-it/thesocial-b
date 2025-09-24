import { Context, Next } from "hono";
import { jwt } from "hono/jwt";

interface JwtPayload {
  id: string;
  email: string;
  iat: number;
  exp: number;
}

export const authMiddleware = async (c: Context, next: Next) => {
  const jwtSecret = process.env.JWT_SECRET as string;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not set in Hono's environment context.");
    return c.json({ message: "Internal server configuration error" }, 500);
  }

  const jwtVerifier = jwt({
    secret: jwtSecret,
  });

  try {
    await jwtVerifier(c, async () => {
      const payload = c.get("jwtPayload") as JwtPayload;
      c.set("user", payload);
      await next();
    });
  } catch (error: any) {
    const errorCode = error?.code;
    console.log(errorCode);

    let message = "Unauthorized.";

    if (errorCode === "ERR_JWT_EXPIRED") {
      message = "Token has expired. Please sign in again.";
    } else if (error.message.includes("signature")) {
      message = "Invalid token signature.";
    }

    return c.json({ error: "Unauthorized", message: message }, 401);
  }
};
