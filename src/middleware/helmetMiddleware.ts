import { Context, Next } from "hono";

const helmetMiddleware = async (c: Context, next: Next) => {
  c.res.headers.set("X-DNS-Prefetch-Control", "off");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  c.res.headers.set("X-Download-Options", "noopen");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Permitted-Cross-Domain-Policies", "none");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("X-XSS-Protection", "0");
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' https://res.cloudinary.com https://lh3.googleusercontent.com data:; media-src 'self' https://res.cloudinary.com; object-src 'none'; frame-ancestors 'none'"
  );
  await next();
};

export default helmetMiddleware;
