import { Context, Next } from "hono";

export const validateInput = (fields: string[]) => {
  return async (c: Context, next: Next) => {
    const body = await c.req.json().catch(() => ({}));
    for (const field of fields) {
      if (!(field in body)) {
        return c.json({ error: `Missing field: ${field}` }, 400);
      }
    }
    await next();
  };
};
