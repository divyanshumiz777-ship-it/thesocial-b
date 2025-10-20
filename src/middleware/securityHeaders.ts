import { MiddlewareHandler } from "hono";

const securityHeaders: MiddlewareHandler = async (c, next) => {
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-XSS-Protection", "1; mode=block");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  await next();
};

export default securityHeaders;
