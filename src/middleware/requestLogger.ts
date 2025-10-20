import { MiddlewareHandler } from "hono";
import logger from "../lib/logger.ts";

const requestLogger: MiddlewareHandler = async (c, next) => {
  const { method, url } = c.req;
  logger.info({ method, url }, "Incoming request");
  await next();
};

export default requestLogger;
