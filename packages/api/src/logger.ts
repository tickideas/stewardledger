// packages/api/src/logger.ts
// Pino structured logger.

import pino from "pino";
import { env } from "./env";

export const log = pino({
  level: env.LOG_LEVEL,
  base: { service: "stewardledger-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(bindings: Record<string, unknown>) {
  return log.child(bindings);
}
