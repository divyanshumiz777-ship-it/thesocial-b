import { Context, Next } from "hono";
import logger from "../lib/logger.ts";

const requestLogger = async (c: Context, next: Next) => {
  const { method, url } = c.req;
  logger.info({ method, url }, "Incoming request");
  await next();
};

export default requestLogger;
