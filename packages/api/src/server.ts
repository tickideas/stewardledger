// packages/api/src/server.ts
// API process bootstrap.

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { env } from "./env";
import { log } from "./logger";

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "stewardledger-api listening");
});

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
