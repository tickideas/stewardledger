// packages/api/src/server.ts
// API process bootstrap.

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { bootstrapSuperAdminFromEnv } from "./bootstrap-super-admin";
import { env } from "./env";
import { log } from "./logger";
import {
  startReportJobsWorker,
  stopReportJobsWorker,
} from "./services/reports/jobs-worker";

const app = createApp();

// Fire-and-forget: an optional env-driven super-admin bootstrap. Logs but
// never blocks server start — a misconfigured bootstrap should not prevent
// the rest of the platform from coming up.
void bootstrapSuperAdminFromEnv();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "stewardledger-api listening");
});

// In-process worker for async report exports. Started after the HTTP
// server is listening so a worker crash on boot doesn't take the API
// down with it. PR 2 replaces this with a pg-boss worker; the route
// contract is identical.
startReportJobsWorker();

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down");
  // Drain the worker first so an in-flight job finishes (or hits its
  // 10 s deadline) before we close the HTTP listener. The order
  // matters: tearing down the DB pool under a running render would
  // surface as a `failed` row with a confusing error.
  await stopReportJobsWorker();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
