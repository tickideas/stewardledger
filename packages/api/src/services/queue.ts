// packages/api/src/services/queue.ts
// Phase 7 PR 2 — pg-boss singleton.
//
// One process-wide pg-boss instance. Owns its own schema (`pgboss`)
// against the same `DATABASE_URL` the rest of the app uses. Started
// after the HTTP server is listening so a queue-start failure
// doesn't take the API down, and stopped on SIGTERM with a 10s
// graceful drain.
//
// The publisher (`services/reports/jobs.ts` → `enqueueReportJob`)
// and the subscriber bootstrap (`services/reports/jobs-pgboss.ts`)
// both route through `getBoss()`; tests that don't exercise the
// queue avoid calling it.
//
// RELEVANT FILES: packages/api/src/services/reports/jobs-pgboss.ts, packages/api/src/server.ts

import { PgBoss } from "pg-boss";
import { env } from "../env";
import { log } from "../logger";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

/**
 * Lazy-start the singleton. Multiple concurrent callers during boot
 * share the same in-flight `start()` promise so we don't double-init
 * the `pgboss` schema.
 */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    const b = new PgBoss({
      connectionString: env.DATABASE_URL,
      // Keep pg-boss in its own schema. `boss.start()` runs the
      // schema bootstrap idempotently — safe on every restart.
      schema: "pgboss",
    });
    b.on("error", (err: Error) => log.error({ err }, "pg-boss error"));
    await b.start();
    boss = b;
    log.info("pg-boss started");
    return b;
  })();
  try {
    return await starting;
  } catch (err) {
    // Reset the latch so a later caller can retry on transient
    // failures (e.g. test DB hadn't finished migrating yet).
    starting = null;
    throw err;
  }
}

/**
 * Graceful shutdown. Resolves once in-flight work drains or the
 * 10s deadline expires, whichever first.
 */
export async function stopBoss(): Promise<void> {
  if (!boss) return;
  const current = boss;
  boss = null;
  starting = null;
  await current.stop({ graceful: true, timeout: 10_000 });
  log.info("pg-boss stopped");
}

/** Test helper: drop the singleton without invoking `stop()`. */
export function resetBossForTesting(): void {
  boss = null;
  starting = null;
}
