// packages/api/src/server.ts
// API process bootstrap.

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { bootstrapSuperAdminFromEnv } from "./bootstrap-super-admin";
import { env } from "./env";
import { log } from "./logger";
import { stopBoss } from "./services/queue";
import { startReportQueue } from "./services/reports/jobs-pgboss";
import { startRetentionSweep } from "./services/retention/cron";
import { startZoneExportQueue } from "./services/exports/jobs-pgboss";

const app = createApp();

// Fire-and-forget: an optional env-driven super-admin bootstrap. Logs but
// never blocks server start — a misconfigured bootstrap should not prevent
// the rest of the platform from coming up.
void bootstrapSuperAdminFromEnv();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, "stewardledger-api listening");
});

// Phase 7 PR 2: pg-boss-backed report queue. Started after the HTTP
// server is listening so a queue-start failure doesn't take the API
// down with it. The boot sweep inside `startReportQueue` recovers
// any rows whose `boss.send` failed during a previous crash window.
void startReportQueue().catch((err) =>
  log.error({ err }, "report queue: failed to start"),
);

// Phase 9: daily per-zone retention sweep. Same posture as the report
// queue — a failure here logs but never blocks the API. Reuses the
// same pg-boss singleton.
void startRetentionSweep().catch((err) =>
  log.error({ err }, "retention sweep: failed to start"),
);

// Phase 9 §3: per-zone export bundle queue + daily cleanup sweep.
// Same posture as the others; the boot sweep inside
// `startZoneExportQueue` recovers orphaned rows.
void startZoneExportQueue().catch((err) =>
  log.error({ err }, "zone export queue: failed to start"),
);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down");
  // Close the HTTP listener first so we stop accepting new
  // requests (and therefore stop creating new `queued` rows that
  // would race the boss shutdown). Then drain pg-boss — it waits
  // up to 10s for in-flight handlers to finish. Anything still in
  // `queued` when boss closes is recovered by the boot sweep on
  // the next process start.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
