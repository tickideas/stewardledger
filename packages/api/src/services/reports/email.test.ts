// packages/api/src/services/reports/email.test.ts
// Phase 7 PR 2 \u2014 the success/failure mail for a finalized report
// job. The send target is the existing `services/email.ts` adapter;
// the contract we care about is: subject + body + idempotency on
// `email_sent_at`.

import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  reportJobs,
  user as userTable,
  zones,
  type ReportJob,
} from "@stewardledger/db/schema";
import { db } from "../../db";
import * as emailService from "../email";
import { sendReportJobEmail } from "./email";

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("report email \u2014 sendReportJobEmail", () => {
  let zoneId: string;
  let zoneSlug: string;
  let userId: string;
  const slugs: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("email.test.ts requires a *_test DATABASE_URL");
    }
    zoneSlug = `em-${unique()}`;
    const [zone] = await db
      .insert(zones)
      .values({
        slug: zoneSlug,
        name: `Email Zone ${unique()}`,
        countryCode: "GB",
        defaultCurrencyCode: "GBP",
        defaultTimeZone: "Europe/London",
        regionNameUnverified: `Region ${unique()}`,
        status: "active",
      })
      .returning({ id: zones.id });
    zoneId = zone.id;
    slugs.push(zoneSlug);

    userId = `u-${unique()}`;
    await db.insert(userTable).values({
      id: userId,
      email: `em-${unique()}@example.com`,
      name: "Edna Treasurer",
      emailVerified: true,
    });
    userIds.push(userId);
  });

  afterAll(async () => {
    for (const slug of slugs) {
      await db.execute(sql`delete from zones where slug = ${slug}`);
    }
    for (const id of userIds) {
      await db.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(reportJobs).where(eq(reportJobs.zoneId, zoneId));
  });

  async function insertJob(
    args: Partial<ReportJob> & {
      status: "completed" | "failed";
    },
  ): Promise<ReportJob> {
    const [row] = await db
      .insert(reportJobs)
      .values({
        zoneId,
        userId,
        reportId: args.reportId ?? "member-statement",
        format: args.format ?? "xlsx",
        status: args.status,
        storageKey: args.storageKey ?? null,
        rowCount: args.rowCount ?? null,
        byteCount: args.byteCount ?? null,
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage ?? null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .returning();
    return row;
  }

  it("sends a branded 'ready' email for a completed job", async () => {
    const job = await insertJob({
      status: "completed",
      storageKey: `${zoneId}/reports/2025/01/x.xlsx`,
      rowCount: 12,
      byteCount: 2048,
    });
    const spy = vi
      .spyOn(emailService, "sendEmail")
      .mockResolvedValue({ ok: true, transport: "usesend", endpoint: "x" });

    const result = await sendReportJobEmail(db, { job });
    expect(result.sent).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0][0];
    expect(message.subject).toMatch(/Member statement.*ready/i);
    expect(message.body).toContain("Edna Treasurer");
    expect(message.html).toContain("Open StewardLedger");

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, job.id));
    expect(row.emailSentAt).not.toBeNull();
  });

  it("sends a failure email carrying the errorMessage", async () => {
    const job = await insertJob({
      status: "failed",
      errorCode: "crash",
      errorMessage: "Spec threw at row 17",
    });
    const spy = vi
      .spyOn(emailService, "sendEmail")
      .mockResolvedValue({ ok: true, transport: "usesend", endpoint: "x" });

    const result = await sendReportJobEmail(db, { job });
    expect(result.sent).toBe(true);
    const message = spy.mock.calls[0][0];
    expect(message.subject).toMatch(/Member statement.*failed/i);
    expect(message.body).toContain("Spec threw at row 17");
    expect(message.html).toContain("Spec threw at row 17");
  });

  it("is idempotent: a second call no-ops when email_sent_at is set", async () => {
    const job = await insertJob({ status: "completed" });
    const spy = vi
      .spyOn(emailService, "sendEmail")
      .mockResolvedValue({ ok: true, transport: "usesend", endpoint: "x" });

    const first = await sendReportJobEmail(db, { job });
    expect(first.sent).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Re-read the row so `job` reflects the freshly stamped
    // emailSentAt; the function also guards via a DB read so the
    // stale `job` argument wouldn't double-send either.
    const [refreshed] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, job.id));
    const second = await sendReportJobEmail(db, { job: refreshed });
    expect(second.sent).toBe(false);
    expect(second.reason).toBe("already-sent");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("treats the dev-log transport as success for idempotency purposes", async () => {
    const job = await insertJob({ status: "completed" });
    const spy = vi
      .spyOn(emailService, "sendEmail")
      .mockResolvedValue({
        ok: false,
        transport: "dev-log",
        reason: "missing-config",
        detail: "no USESEND",
      });

    const result = await sendReportJobEmail(db, { job });
    // Caller-visible signal: not sent (no real network send) but
    // also not retryable \u2014 we logged it and stamped the row.
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("dev-log");
    expect(spy).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, job.id));
    expect(row.emailSentAt).not.toBeNull();
  });

  it("leaves email_sent_at null on a transient send failure so a redeliver retries", async () => {
    const job = await insertJob({ status: "completed" });
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({
      ok: false,
      transport: "usesend",
      reason: "network",
      detail: "ECONNRESET",
      endpoint: "https://send.example",
    });

    const result = await sendReportJobEmail(db, { job });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("send-failed");

    const [row] = await db
      .select()
      .from(reportJobs)
      .where(eq(reportJobs.id, job.id));
    expect(row.emailSentAt).toBeNull();
  });
});
