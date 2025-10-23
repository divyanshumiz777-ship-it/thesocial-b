import { Context, Next } from "hono";

const helmetMiddleware = async (c: Context, next: Next) => {
  c.res.headers.set("X-DNS-Prefetch-Control", "off");
  c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
  c.res.headers.set(
    "Strict-Transport-Security",
    "max-age=15552000; includeSubDomains"
  );
  c.res.headers.set("X-Download-Options", "noopen");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Permitted-Cross-Domain-Policies", "none");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("X-XSS-Protection", "0");
  await next();
};

export default helmetMiddleware;
