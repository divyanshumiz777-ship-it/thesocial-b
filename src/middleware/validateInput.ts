import { MiddlewareHandler } from "hono";

export const validateInput = (fields: string[]): MiddlewareHandler => {
  return async (c, next) => {
    const body = await c.req.json().catch(() => ({}));
    for (const field of fields) {
      if (!(field in body)) {
        return c.json({ error: `Missing field: ${field}` }, 400);
      }
    }
    await next();
  };
};
